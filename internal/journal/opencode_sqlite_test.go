package journal

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sqliteFixture(t *testing.T, db, sql string) {
	t.Helper()
	binary, err := exec.LookPath("sqlite3")
	if err != nil {
		t.Skip("sqlite3 unavailable")
	}
	command := exec.Command(binary, db, sql)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("sqlite: %v %s", err, out)
	}
}

func TestOpencodeSQLiteObservation(t *testing.T) {
	for _, agent := range []string{"opencode", "kilo"} {
		t.Run(agent, func(t *testing.T) {
			root := t.TempDir()
			db := filepath.Join(root, agent+".db")
			sqliteFixture(t, db, `create table session(id text primary key,title text,revert text);
create table message(id text,session_id text,time_created integer,data text);
create table part(id text,message_id text,session_id text,data text);
insert into session values('ses_native123','Native session title',null),('ses_other123','Other session',null);
insert into message values('msg_1','ses_native123',1,'{"role":"user","time":{"created":1767225600000}}'),('msg_2','ses_native123',2,'{"role":"assistant"}'),('msg_3','ses_native123',3,'{"role":"user"}');
insert into part values('prt_1','msg_1','ses_native123','{"type":"text","text":"Fix session titles"}'),('prt_hidden','msg_1','ses_native123','{"type":"text","text":"hidden synthetic","synthetic":true}'),('prt_2','msg_2','ses_native123','{"type":"tool","tool":"Read","callID":"call-1","state":{"status":"completed","input":{"file_path":"src/main.ts"},"output":"file content"}}'),('prt_3','msg_3','ses_native123','{"type":"text","text":"Abandoned request"}'),('prt_cross','msg_1','ses_other123','{"type":"text","text":"hidden other session"}');
update session set revert='{"messageID":"msg_3"}' where id='ses_native123';`)
			r := &Reader{OpencodeRoot: root, NativeRoots: map[string]string{"kilo": root}}
			ref := Ref{Source: "herdr:" + agent, Agent: agent, Kind: "id", Value: "ses_native123"}
			if title := r.ReadTitle(ref); title.Name != "Native session title" || title.Prompt != "Fix session titles" {
				t.Fatalf("title %+v", title)
			}
			page, err := r.Read(ref, nil, 50)
			if err != nil || len(page.Messages) != 2 || page.Messages[0].Text != "Fix session titles" {
				t.Fatalf("history %+v %v", page, err)
			}
			activity, ok := r.ReadTurnActivity(ref, TurnDone)
			if !ok || activity.Name != "Read" || activity.State != "done" || activity.Turn == nil || activity.Turn.Steps != 1 {
				t.Fatalf("activity %+v %v", activity, ok)
			}
			sqliteFixture(t, db, `update session set title='Renamed' where id='ses_native123';`)
			r.now = func() time.Time { return time.Now().Add(3 * time.Second) }
			if title := r.ReadTitle(ref); title.Name != "Renamed" {
				t.Fatalf("rename %+v", title)
			}
			ref.Value = "ses_missing123"
			if r.Available(ref) || r.ReadTitle(ref) != (Title{}) {
				t.Fatal("missing session accepted")
			}
		})
	}
}

func TestOpencodeSQLiteV2Observation(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(root, "kilo.db")
	sqliteFixture(t, db, `create table session(id text primary key,title text,revert text);
create table session_message(id text,session_id text,type text,seq integer,data text);
insert into session values('ses_native123','V2 title',null);
insert into session_message values('msg_sys','ses_native123','synthetic',0,'{"text":"hidden instructions"}'),('msg_1','ses_native123','user',1,'{"text":"Fix session titles","time":{"created":1767225600000}}'),('msg_2','ses_native123','assistant',2,'{"content":[{"type":"tool","id":"call-1","name":"Read","state":{"status":"error","input":{"file_path":"src/main.ts"},"content":[{"type":"text","text":"Not found"}]}}]}'),('msg_pending','ses_native123','user',null,'{"text":"hidden uncommitted"}'),('msg_injected','ses_native123','user',3,'{"text":"<system-reminder>plan mode</system-reminder>","time":{"created":1767225600003}}');`)
	r := &Reader{NativeRoots: map[string]string{"kilo": root}}
	ref := Ref{Source: "herdr:kilo", Agent: "kilo", Kind: "id", Value: "ses_native123"}
	page, err := r.Read(ref, nil, 50)
	if err != nil || len(page.Messages) != 2 {
		t.Fatalf("history %+v %v", page, err)
	}
	if title := r.ReadTitle(ref); title.Prompt != "Fix session titles" {
		t.Fatalf("title %+v", title)
	}
	activity, ok := r.ReadTurnActivity(ref, TurnDone)
	if !ok || activity.State != "error" || !strings.Contains(activity.Label, "src/main.ts") || !activity.Turn.Failed {
		t.Fatalf("activity %+v %v", activity, ok)
	}
}

func TestOpencodeSQLiteRowsRejectCrossSession(t *testing.T) {
	if _, err := opencodeV1Rows([]byte(`[{"sid":"other-session","mid":"msg_1","message":"{}"}]`), "ses_native123", "", ""); err == nil {
		t.Fatal("v1 accepted mismatched session")
	}
	if _, err := opencodeV2Rows([]byte(`[{"sid":"other-session","id":"msg_1","type":"user","data":"{}"}]`), "ses_native123", ""); err == nil {
		t.Fatal("v2 accepted mismatched session")
	}
}

func TestOpencodeV2SessionTableAndEmptyTitle(t *testing.T) {
	root := t.TempDir()
	db := filepath.Join(root, "opencode.db")
	sqliteFixture(t, db, `create table session_v2(id text primary key,title text,revert text);
create table session_message(id text,session_id text,type text,seq integer,data text);
insert into session_v2 values('ses_native123','A named empty session',null);
insert into session_v2 values('ses_populated123','A populated session',null);
insert into session_message values('msg_1','ses_populated123','user',1,'{"text":"Fix new session titles"}');`)
	r := &Reader{OpencodeRoot: root}
	ref := Ref{Source: "herdr:opencode", Agent: "opencode", Kind: "id", Value: "ses_native123"}
	if title := r.ReadTitle(ref); title.Name != "A named empty session" {
		t.Fatalf("empty title %+v", title)
	}
	if page, err := r.Read(ref, nil, 50); err != nil || len(page.Messages) != 0 {
		t.Fatalf("empty history %+v %v", page, err)
	}
	ref.Value = "ses_populated123"
	if title := r.ReadTitle(ref); title.Prompt != "Fix new session titles" {
		t.Fatalf("v2 title %+v", title)
	}
}

// A session longer than the bound keeps its newest messages, exactly as the
// pre-1.2 file layout does, instead of becoming unreadable.
func TestOpencodeSQLiteKeepsNewestMessagesInLongSessions(t *testing.T) {
	for _, tc := range []struct {
		name  string
		total int
		sql   string
	}{
		{
			name:  "v2",
			total: 2105,
			sql: `create table session(id text primary key,title text,revert text);
create table session_message(id text,session_id text,type text,seq integer,data text);
insert into session values('ses_long123','Long session',null);
with recursive n(i) as (select 1 union all select i+1 from n where i<2105)
insert into session_message select 'msg_'||i,'ses_long123','user',i,'{"text":"prompt '||i||'","time":{"created":'||i||'}}' from n;`,
		},
		{
			name:  "v1",
			total: 2010,
			sql: `create table session(id text primary key,title text,revert text);
create table message(id text,session_id text,time_created integer,data text);
create table part(id text,message_id text,session_id text,data text);
insert into session values('ses_long123','Long session',null);
with recursive n(i) as (select 1 union all select i+1 from n where i<2010)
insert into message select 'msg_'||i,'ses_long123',i,'{"role":"user"}' from n;
with recursive n(i) as (select 1 union all select i+1 from n where i<2010)
insert into part select 'prt_'||i,'msg_'||i,'ses_long123','{"type":"text","text":"prompt '||i||'"}' from n;`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			sqliteFixture(t, filepath.Join(root, "opencode.db"), tc.sql)
			r := &Reader{OpencodeRoot: root}
			ref := Ref{Source: "herdr:opencode", Agent: "opencode", Kind: "id", Value: "ses_long123"}
			snapshot, err := r.loadStore(ref, true)
			if err != nil {
				t.Fatalf("long session unavailable: %v", err)
			}
			lines := strings.Split(strings.TrimSpace(string(snapshot.data)), "\n")
			if len(lines) != maxOpencodeMessages {
				t.Fatalf("records=%d want %d", len(lines), maxOpencodeMessages)
			}
			want := fmt.Sprintf("prompt %d", tc.total-maxOpencodeMessages+1)
			var oldest, newest storeRecord
			if err := json.Unmarshal([]byte(lines[0]), &oldest); err != nil || oldest.Text != want {
				t.Fatalf("oldest=%+v want %q err=%v", oldest, want, err)
			}
			if err := json.Unmarshal([]byte(lines[len(lines)-1]), &newest); err != nil || newest.Text != fmt.Sprintf("prompt %d", tc.total) {
				t.Fatalf("newest=%+v err=%v", newest, err)
			}
			page, err := r.Read(ref, nil, 200)
			if err != nil || len(page.Messages) != 200 || page.Messages[0].Text != want {
				t.Fatalf("page=%+v err=%v", page, err)
			}
		})
	}
}
