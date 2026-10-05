package journal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Hermes Agent stores every session in <root>/state.db (SQLite, WAL). The
// daemon has no SQLite reader of its own: it asks the system sqlite3 for one
// session's rows, read-only. Where sqlite3 is missing, or the database is from
// a Hermes whose columns differ, the session is unavailable.

const (
	hermesQueryTimeout = 3 * time.Second
	// tool_calls is JSON and cannot be cut; a call list larger than this is
	// left out and its results show without a tool.
	maxHermesCalls = 1 << 20
	// sqlite3's reply for one session.
	maxHermesReply = 2 * maxStoreBytes
)

// %[1]s is a session id already matched against sessionID, so it holds no
// quote. The left join yields one all-null message row for an empty session and
// nothing at all for an unknown one. A tool result is read as JSON only inside
// nested CASEs: SQLite may evaluate the operands of AND in any order, and
// json_extract on text that is not JSON fails the whole query.
const hermesQuery = `with rows as (
 select m.*, case when m.role = 'tool' then case when json_valid(m.content) then 1 end end as json
 from messages m where m.session_id = '%[1]s' and m.active = 1)
select s.id as sid, m.id as id, m.role as role,
 substr(m.content, 1, %[2]d) as content, m.tool_call_id as call,
 case when length(m.tool_calls) <= %[3]d then m.tool_calls end as calls,
 m.timestamp as at, substr(coalesce(m.reasoning, m.reasoning_content), 1, %[2]d) as reasoning,
 m.display_kind as display,
 case when m.json then json_extract(m.content, '$.exit_code') end as exit_code,
 case when m.json then json_extract(m.content, '$.success') end as success,
 case when m.json then case when json_type(m.content, '$.error') = 'text'
  then substr(json_extract(m.content, '$.error'), 1, 4096) end end as error,
 case when m.json then case when json_type(m.content, '$.output') = 'text'
  then substr(json_extract(m.content, '$.output'), 1, %[2]d) end end as output,
 case when m.json then json_type(m.content, '$.output') = 'text' end as shell
 from sessions s left join rows m on m.session_id = s.id
 where s.id = '%[1]s' order by m.id;`

type hermesRow struct {
	Session   string          `json:"sid"`
	ID        *int64          `json:"id"`
	Role      string          `json:"role"`
	Content   string          `json:"content"`
	Call      string          `json:"call"`
	Calls     string          `json:"calls"`
	At        float64         `json:"at"`
	Reasoning string          `json:"reasoning"`
	Display   string          `json:"display"`
	ExitCode  json.RawMessage `json:"exit_code"`
	Success   json.RawMessage `json:"success"`
	Error     string          `json:"error"`
	Output    string          `json:"output"`
	// Shell is 1 when the result is a JSON object with a text "output": that
	// text is the tool's output, and the rest of the object is bookkeeping.
	Shell int `json:"shell"`
}

var (
	sqliteOnce sync.Once
	sqlitePath string
)

func (r *Reader) hermesDB() (string, error) {
	if r.HermesRoot == "" {
		return "", ErrUnavailable
	}
	path, err := verifiedRegular(r.HermesRoot, filepath.Join(r.HermesRoot, "state.db"))
	if err != nil {
		return "", ErrUnavailable
	}
	return path, nil
}

// hermesStamp describes the database and its write-ahead log; every session
// shares them, so an equal stamp means no session changed.
func (r *Reader) hermesStamp() (string, error) {
	db, err := r.hermesDB()
	if err != nil {
		return "", err
	}
	return fileStamp(db) + "|" + fileStamp(db+"-wal"), nil
}

func fileStamp(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "-"
	}
	return strconv.FormatInt(info.Size(), 10) + ":" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
}

func (r *Reader) loadHermes(id string) ([]storeRecord, error) {
	if !sessionID.MatchString(id) {
		return nil, ErrUnavailable
	}
	db, err := r.hermesDB()
	if err != nil {
		return nil, err
	}
	query := r.sqlite
	if query == nil {
		query = runSQLite
	}
	ctx, cancel := context.WithTimeout(context.Background(), hermesQueryTimeout)
	defer cancel()
	reply, err := query(ctx, db, fmt.Sprintf(hermesQuery, id, maxStoreField, maxHermesCalls))
	if err != nil {
		return nil, err
	}
	var rows []hermesRow
	if len(reply) == 0 || json.Unmarshal(reply, &rows) != nil || len(rows) == 0 || rows[0].Session != id {
		// No row at all: Hermes has no such session.
		return nil, ErrUnavailable
	}
	return hermesRecords(rows), nil
}

// runSQLite prints one read-only query's rows as a JSON array. The user's
// ~/.sqliterc is not read.
func runSQLite(ctx context.Context, db, sql string) ([]byte, error) {
	sqliteOnce.Do(func() {
		for _, candidate := range []string{"/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"} {
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				sqlitePath = candidate
				return
			}
		}
		sqlitePath, _ = exec.LookPath("sqlite3")
	})
	if sqlitePath == "" {
		return nil, ErrUnavailable
	}
	cmd := exec.CommandContext(ctx, sqlitePath, "-init", os.DevNull, "-batch", "-readonly", "-json", "-cmd", ".timeout 1000", db, sql)
	cmd.Env = []string{"LC_ALL=C"}
	out := &boundedBuffer{limit: maxHermesReply}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil || out.overflow {
		return nil, ErrUnavailable
	}
	return out.data, nil
}

// boundedBuffer stops a child that prints more than limit.
type boundedBuffer struct {
	data     []byte
	limit    int
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > b.limit {
		b.overflow = true
		return 0, errors.New("reply exceeds bound")
	}
	b.data = append(b.data, p...)
	return len(p), nil
}

func hermesRecords(rows []hermesRow) []storeRecord {
	records := make([]storeRecord, 0, len(rows))
	for _, row := range rows {
		if row.ID == nil {
			continue
		}
		at := int64(row.At * 1000)
		hidden := row.Display == "hidden"
		switch row.Role {
		case "user":
			if hidden {
				continue
			}
			if kind, text := hermesUserText(row.Content); text != "" {
				records = append(records, storeRecord{Kind: kind, Text: text, At: at})
			}
		case "assistant":
			if hidden {
				// Hermes records a turn the user cut short as a hidden note.
				if strings.HasPrefix(row.Content, "[This response was interrupted") {
					records = append(records, storeRecord{Kind: storeInterrupt, At: at})
				}
				continue
			}
			if strings.TrimSpace(row.Reasoning) != "" {
				records = append(records, storeRecord{Kind: storeThinking, Text: row.Reasoning, At: at})
			}
			if text := hermesContentText(row.Content); strings.TrimSpace(text) != "" {
				records = append(records, storeRecord{Kind: storeAssistant, Text: text, At: at})
			}
			for _, call := range hermesCalls(row.Calls) {
				records = append(records, storeRecord{Kind: storeTool, Name: call.name, Call: call.id, Input: call.input, At: at})
			}
		case "tool":
			if hidden {
				continue
			}
			output := row.Content
			if row.Shell == 1 {
				output = row.Output
				if row.Error != "" && !strings.Contains(output, row.Error) {
					output = strings.TrimSpace(output + "\n" + row.Error)
				}
			}
			records = append(records, storeRecord{Kind: storeResult, Call: row.Call, Output: output, State: hermesToolState(row), At: at})
		}
	}
	return records
}

var hermesSkillPrompt = regexp.MustCompile(`^\[SYSTEM: The user has invoked the "([0-9A-Za-z_.:-]{1,64})" skill`)

// hermesUserText keeps what the user sent. A skill invocation is stored as the
// skill's whole text behind a [SYSTEM: …] line and reads as its command; other
// [SYSTEM: …] messages are Hermes speaking to the model.
func hermesUserText(content string) (kind, text string) {
	content = hermesContentText(content)
	if match := hermesSkillPrompt.FindStringSubmatch(content); match != nil {
		return storeCommand, "/" + match[1]
	}
	if strings.HasPrefix(content, "[SYSTEM:") {
		return "", ""
	}
	return storeUser, strings.TrimSpace(content)
}

// hermesContentText flattens a multi-part message (text beside images) to its text.
func hermesContentText(content string) string {
	if !strings.HasPrefix(content, "[{") {
		return content
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(content), &parts) != nil {
		return content
	}
	texts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part.Type == "text" && part.Text != "" {
			texts = append(texts, part.Text)
		}
	}
	return strings.Join(texts, "\n")
}

type hermesCall struct{ id, name, input string }

func hermesCalls(raw string) []hermesCall {
	if raw == "" {
		return nil
	}
	var calls []struct {
		ID       string `json:"id"`
		CallID   string `json:"call_id"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	if json.Unmarshal([]byte(raw), &calls) != nil {
		return nil
	}
	out := make([]hermesCall, 0, len(calls))
	for _, call := range calls {
		id := call.ID
		if id == "" {
			id = call.CallID
		}
		out = append(out, hermesCall{id: id, name: call.Function.Name, input: compactJSON(json.RawMessage(call.Function.Arguments))})
	}
	return out
}

// hermesToolState reads how a tool ended from its JSON result: a shell exit
// code, a success flag, or an error message.
func hermesToolState(row hermesRow) string {
	if code, err := strconv.ParseFloat(string(row.ExitCode), 64); err == nil {
		if code != 0 {
			return "error"
		}
		return "done"
	}
	if flag := string(row.Success); flag == "0" || flag == "false" {
		return "error"
	}
	if row.Error != "" {
		return "error"
	}
	return "done"
}
