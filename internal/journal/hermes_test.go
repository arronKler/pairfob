package journal

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const hermesTestID = "20260414_000920_7820a4"

func hermesTestRef() Ref {
	return Ref{Source: "herdr:hermes", Agent: "hermes", Kind: "id", Value: hermesTestID}
}

// hermesTestReader answers the session query with rows instead of running sqlite3.
func hermesTestReader(t *testing.T, rows func() []map[string]any) *Reader {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "state.db"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	return &Reader{HermesRoot: root, sqlite: func(_ context.Context, _, sql string) ([]byte, error) {
		if !strings.Contains(sql, "where s.id = '"+hermesTestID+"'") {
			t.Fatalf("query does not name the bound session: %s", sql)
		}
		list := rows()
		if list == nil {
			return nil, nil
		}
		return json.Marshal(list)
	}}
}

func hermesRowFixture(id int, role string, fields map[string]any) map[string]any {
	row := map[string]any{"sid": hermesTestID, "id": id, "role": role, "at": 1776096847.5 + float64(id)}
	for key, value := range fields {
		row[key] = value
	}
	return row
}

func hermesToolCalls(calls ...[3]string) string {
	list := make([]map[string]any, 0, len(calls))
	for _, call := range calls {
		list = append(list, map[string]any{"id": call[0], "type": "function", "function": map[string]any{"name": call[1], "arguments": call[2]}})
	}
	data, _ := json.Marshal(list)
	return string(data)
}

func hermesSummary(t *testing.T, reader *Reader, options TraceOptions) []string {
	t.Helper()
	page, err := reader.ReadTraceSummaryWith(hermesTestRef(), nil, 50, options)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		out = append(out, strings.TrimRight(strings.Join([]string{item.Type, item.Name, item.State, item.Label, item.Text}, "|"), "|"))
	}
	return out
}

func TestHermesSessionReadsAsTurnsToolsAndResults(t *testing.T) {
	reader := hermesTestReader(t, func() []map[string]any {
		return []map[string]any{
			hermesRowFixture(1, "session_meta", map[string]any{"content": "tools"}),
			hermesRowFixture(2, "user", map[string]any{"content": "Add an outer loop."}),
			hermesRowFixture(3, "assistant", map[string]any{"content": "Looking first.", "reasoning": "Find the loop script.",
				"calls": hermesToolCalls([3]string{"c1", "terminal", `{"command": "ls -la", "workdir": "~/p"}`}, [3]string{"c2", "read_file", `{"path":"~/p/run.sh"}`})}),
			hermesRowFixture(4, "tool", map[string]any{"call": "c1", "content": `{"output": "total 0", "exit_code": 0, "error": null}`, "output": "total 0", "exit_code": 0, "shell": 1}),
			hermesRowFixture(5, "tool", map[string]any{"call": "c2", "content": `{"content": "", "error": "File not found"}`, "error": "File not found"}),
			hermesRowFixture(6, "assistant", map[string]any{"calls": hermesToolCalls([3]string{"c3", "terminal", `{"command":"make test"}`})}),
			hermesRowFixture(7, "tool", map[string]any{"call": "c3", "content": `{"output": "1 failed", "exit_code": 2}`, "output": "1 failed", "exit_code": 2, "shell": 1}),
			hermesRowFixture(8, "assistant", map[string]any{"content": "One test fails."}),
		}
	})
	got := hermesSummary(t, reader, TraceOptions{Labels: true})
	want := []string{
		"user||||Add an outer loop.", "thinking||||Find the loop script.", "assistant||||Looking first.",
		"tool|terminal|done|ls -la", "tool|read_file|error|~/p/run.sh", "tool|terminal|error|make test", "assistant||||One test fails.",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("summary:\n got %q\nwant %q", got, want)
	}
	page, err := reader.ReadTraceWith(hermesTestRef(), nil, 50, TraceOptions{Times: true})
	if err != nil {
		t.Fatal(err)
	}
	if tool := page.Items[3]; tool.Input != `{"command":"ls -la","workdir":"~/p"}` || tool.Output != "total 0" || tool.At != 1776096850500 {
		t.Fatalf("tool=%+v", tool)
	}
	// A result that is not a shell result keeps its JSON, which already says what went wrong.
	if tool := page.Items[4]; tool.Output != "{\"content\": \"\", \"error\": \"File not found\"}" {
		t.Fatalf("read_file output=%q", tool.Output)
	}
	detail, err := reader.ReadTraceDetail(hermesTestRef(), page.Items[5].DetailRef)
	if err != nil || detail.Input != `{"command":"make test"}` || detail.Output != "1 failed" {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
	history, err := reader.Read(hermesTestRef(), nil, 50)
	if err != nil || len(history.Messages) != 6 || history.Messages[0] != (Message{Role: "user", Text: "Add an outer loop."}) || history.Messages[2].Text != "工具 · terminal" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	if activity := reader.ReadActivity(hermesTestRef()); !activity.Known || len(activity.Key) != 64 {
		t.Fatalf("activity=%+v", activity)
	}
}

func TestHermesHidesItsOwnMessagesAndShowsSkillsAsCommands(t *testing.T) {
	reader := hermesTestReader(t, func() []map[string]any {
		return []map[string]any{
			hermesRowFixture(1, "user", map[string]any{"content": "[SYSTEM: The user has invoked the \"mcporter\" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n---\nname: mcporter\n<secret skill body>"}),
			hermesRowFixture(2, "assistant", map[string]any{"content": "Ready."}),
			hermesRowFixture(3, "user", map[string]any{"content": "[SYSTEM: Background process finished]"}),
			hermesRowFixture(4, "user", map[string]any{"content": `[{"type":"text","text":"What is in this picture?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]`}),
			hermesRowFixture(5, "assistant", map[string]any{"content": "Half an ans"}),
			hermesRowFixture(6, "assistant", map[string]any{"content": "[This response was interrupted by a user correction.]", "display": "hidden"}),
			hermesRowFixture(7, "user", map[string]any{"content": "hidden note", "display": "hidden"}),
		}
	})
	want := []string{"command||||/mcporter", "assistant||||Ready.", "user||||What is in this picture?", "assistant||||Half an ans", "interrupt"}
	if got := hermesSummary(t, reader, TraceOptions{Markers: true}); !slices.Equal(got, want) {
		t.Fatalf("with markers:\n got %q\nwant %q", got, want)
	}
	// Without markers the command reads as a prompt and the interrupt is dropped.
	want = []string{"user||||/mcporter", "assistant||||Ready.", "user||||What is in this picture?", "assistant||||Half an ans"}
	if got := hermesSummary(t, reader, TraceOptions{}); !slices.Equal(got, want) {
		t.Fatalf("without markers:\n got %q\nwant %q", got, want)
	}
}

func TestHermesUnknownSessionIsUnavailableAndAnEmptyOneIsNot(t *testing.T) {
	var rows []map[string]any
	reader := hermesTestReader(t, func() []map[string]any { return rows })
	clock := time.Unix(1_800_000_000, 0)
	reader.now = func() time.Time { return clock }
	if reader.Available(hermesTestRef()) {
		t.Fatal("a session Hermes does not know is not available")
	}
	if _, err := reader.ReadTrace(hermesTestRef(), nil, 20); err != ErrUnavailable {
		t.Fatalf("unknown session: %v", err)
	}
	// The same database answers the same way until it changes.
	rows = []map[string]any{{"sid": hermesTestID, "id": nil}}
	if _, err := reader.ReadTrace(hermesTestRef(), nil, 20); err != ErrUnavailable {
		t.Fatalf("an unchanged database was asked again: %v", err)
	}
	if err := os.WriteFile(filepath.Join(reader.HermesRoot, "state.db-wal"), []byte("wal"), 0o600); err != nil {
		t.Fatal(err)
	}
	page, err := reader.ReadTrace(hermesTestRef(), nil, 20)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("a new session with no messages is an empty chat: page=%+v err=%v", page, err)
	}
	if !reader.Available(hermesTestRef()) {
		t.Fatal("an empty session is available")
	}
}

func TestHermesPollingReusesARecentRenderingAndPhoneReadsDoNot(t *testing.T) {
	queries := 0
	text := "first"
	reader := hermesTestReader(t, func() []map[string]any {
		queries++
		return []map[string]any{hermesRowFixture(1, "user", map[string]any{"content": text})}
	})
	clock := time.Unix(1_800_000_000, 0)
	reader.now = func() time.Time { return clock }
	touch := func() {
		t.Helper()
		clock = clock.Add(time.Millisecond)
		if err := os.WriteFile(filepath.Join(reader.HermesRoot, "state.db-wal"), []byte(clock.String()), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	first := reader.ReadActivity(hermesTestRef())
	text = "second"
	touch()
	if again := reader.ReadActivity(hermesTestRef()); again != first || queries != 1 {
		t.Fatalf("polling inside the window asked again: queries=%d", queries)
	}
	page, err := reader.ReadTrace(hermesTestRef(), nil, 20)
	if err != nil || page.Items[0].Text != "second" || queries != 2 {
		t.Fatalf("a phone read must look at the store: page=%+v queries=%d err=%v", page, queries, err)
	}
	if _, err := reader.ReadTrace(hermesTestRef(), nil, 20); err != nil || queries != 2 {
		t.Fatalf("an unchanged database was queried again: queries=%d err=%v", queries, err)
	}
	clock = clock.Add(storePollTTL)
	if later := reader.ReadActivity(hermesTestRef()); later == first || !later.Known {
		t.Fatalf("activity did not follow the new prompt: %+v", later)
	}
}

func TestHermesQueryFailureIsUnavailableNotAnEmptyChat(t *testing.T) {
	root := t.TempDir()
	reader := &Reader{HermesRoot: root, sqlite: func(context.Context, string, string) ([]byte, error) {
		t.Fatal("no database, nothing to query")
		return nil, nil
	}}
	if _, err := reader.ReadTrace(hermesTestRef(), nil, 20); err != ErrUnavailable {
		t.Fatalf("missing database: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "state.db"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader.sqlite = func(context.Context, string, string) ([]byte, error) {
		return []byte("Error: no such column: m.active"), nil
	}
	if _, err := reader.ReadTrace(hermesTestRef(), nil, 20); err != ErrUnavailable {
		t.Fatalf("a database from another Hermes: %v", err)
	}
	if reader.Supports(Ref{Source: "herdr:hermes", Agent: "hermes", Kind: "path", Value: filepath.Join(root, "state.db")}) {
		t.Fatal("path binding must fail closed")
	}
}

// The query itself runs against a real database when this machine has sqlite3.
func TestHermesQueryAgainstSQLite(t *testing.T) {
	binary, err := exec.LookPath("sqlite3")
	if err != nil {
		t.Skip("sqlite3 is not installed")
	}
	root := t.TempDir()
	schema := `create table sessions (id text primary key, source text not null, started_at real not null);
create table messages (id integer primary key autoincrement, session_id text not null, role text not null, content text,
 tool_call_id text, tool_calls text, timestamp real not null, reasoning text, reasoning_content text, display_kind text, active integer not null default 1);
insert into sessions values ('` + hermesTestID + `', 'cli', 1), ('20260101_000000_empty1', 'cli', 2);
insert into messages (session_id, role, content, tool_calls, tool_call_id, timestamp, active) values
 ('` + hermesTestID + `', 'user', 'Run it', null, null, 10.25, 1),
 ('` + hermesTestID + `', 'user', 'rewound prompt', null, null, 11, 0),
 ('` + hermesTestID + `', 'assistant', null, '[{"id":"c1","function":{"name":"terminal","arguments":"{\"command\":\"false\"}"}}]', null, 12, 1),
 ('` + hermesTestID + `', 'tool', '{"output": "", "exit_code": 1, "error": "boom"}', null, 'c1', 13, 1),
 ('` + hermesTestID + `', 'tool', 'not json at all', null, 'c9', 14, 1);`
	if out, err := exec.Command(binary, filepath.Join(root, "state.db"), schema).CombinedOutput(); err != nil {
		t.Fatalf("sqlite3: %v %s", err, out)
	}
	reader := &Reader{HermesRoot: root}
	page, err := reader.ReadTraceSummaryWith(hermesTestRef(), nil, 20, TraceOptions{Labels: true, Times: true})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	if page.Items[0].Text != "Run it" || page.Items[0].At != 10250 {
		t.Fatalf("prompt=%+v", page.Items[0])
	}
	if tool := page.Items[1]; tool.Name != "terminal" || tool.Label != "false" || tool.State != "error" {
		t.Fatalf("tool=%+v", tool)
	}
	detail, err := reader.ReadTraceDetail(hermesTestRef(), page.Items[1].DetailRef)
	if err != nil || detail.Output != "boom" {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
	empty := Ref{Source: "herdr:hermes", Agent: "hermes", Kind: "id", Value: "20260101_000000_empty1"}
	if page, err := reader.ReadTrace(empty, nil, 20); err != nil || len(page.Items) != 0 {
		t.Fatalf("empty session: page=%+v err=%v", page, err)
	}
	missing := Ref{Source: "herdr:hermes", Agent: "hermes", Kind: "id", Value: "20260101_000000_nosuch"}
	if _, err := reader.ReadTrace(missing, nil, 20); err != ErrUnavailable {
		t.Fatalf("missing session: %v", err)
	}
}
