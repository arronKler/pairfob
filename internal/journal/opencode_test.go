package journal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const opencodeTestID = "ses_41ea62dbdffeABAkP191ComHDK"

func opencodeTestRef() Ref {
	return Ref{Source: "herdr:opencode", Agent: "opencode", Kind: "id", Value: opencodeTestID}
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// opencodeFixture writes the layout opencode 1.1 keeps under storage/.
type opencodeFixture struct {
	t    *testing.T
	root string
}

func newOpencodeFixture(t *testing.T) opencodeFixture {
	fixture := opencodeFixture{t: t, root: t.TempDir()}
	writeJSONFile(t, filepath.Join(fixture.root, "storage", "session", "global", opencodeTestID+".json"), map[string]any{"id": opencodeTestID, "version": "1.1.28"})
	return fixture
}

func (f opencodeFixture) message(id, role string, created int64, extra map[string]any) {
	value := map[string]any{"id": id, "sessionID": opencodeTestID, "role": role, "time": map[string]any{"created": created}}
	for key, item := range extra {
		value[key] = item
	}
	writeJSONFile(f.t, filepath.Join(f.root, "storage", "message", opencodeTestID, id+".json"), value)
}

func (f opencodeFixture) part(message, id string, value map[string]any) {
	writeJSONFile(f.t, filepath.Join(f.root, "storage", "part", message, id+".json"), value)
}

func (f opencodeFixture) tool(message, id, name, status string, state map[string]any) {
	state["status"] = status
	f.part(message, id, map[string]any{"type": "tool", "tool": name, "callID": "call_" + id, "state": state})
}

func opencodeSummary(t *testing.T, reader *Reader, options TraceOptions) []string {
	t.Helper()
	page, err := reader.ReadTraceSummaryWith(opencodeTestRef(), nil, 50, options)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		out = append(out, strings.TrimRight(strings.Join([]string{item.Type, item.Name, item.State, item.Label, item.Text}, "|"), "|"))
	}
	return out
}

func TestOpencodeSessionReadsMessagesAndPartsInOrder(t *testing.T) {
	fixture := newOpencodeFixture(t)
	fixture.message("msg_001", "user", 1000, map[string]any{"summary": map[string]any{"title": "Listing"}})
	fixture.part("msg_001", "prt_001", map[string]any{"type": "text", "text": "Which folders are here?"})
	fixture.part("msg_001", "prt_002", map[string]any{"type": "text", "text": "<system-reminder>plan mode</system-reminder>", "synthetic": true})
	fixture.message("msg_002", "assistant", 2000, nil)
	fixture.part("msg_002", "prt_001", map[string]any{"type": "step-start"})
	fixture.part("msg_002", "prt_002", map[string]any{"type": "reasoning", "text": "List the directory.", "time": map[string]any{"start": 2100}})
	fixture.part("msg_002", "prt_003", map[string]any{"type": "text", "text": "Let me look."})
	fixture.tool("msg_002", "prt_004", "bash", "completed", map[string]any{
		"input": map[string]any{"command": "ls -la", "description": "list"}, "output": "total 0",
		"metadata": map[string]any{"exit": 0}, "time": map[string]any{"start": 2200, "end": 2300},
	})
	fixture.tool("msg_002", "prt_005", "bash", "completed", map[string]any{
		"input": map[string]any{"command": "false"}, "output": "", "metadata": map[string]any{"exit": 1},
	})
	fixture.tool("msg_002", "prt_006", "read", "error", map[string]any{
		"input": map[string]any{"filePath": "/work/.env"}, "error": "Error: The user rejected permission to use this specific tool call.",
	})
	fixture.tool("msg_002", "prt_007", "grep", "running", map[string]any{"input": map[string]any{"pattern": "TODO"}})
	fixture.part("msg_002", "prt_008", map[string]any{"type": "step-finish", "reason": "tool-calls"})
	reader := &Reader{OpencodeRoot: fixture.root}
	want := []string{
		"user||||Which folders are here?", "thinking||||List the directory.", "assistant||||Let me look.",
		"tool|bash|done|ls -la", "tool|bash|error|false", "tool|read|error|/work/.env", "tool|grep|running|TODO",
	}
	if got := opencodeSummary(t, reader, TraceOptions{Labels: true}); !slices.Equal(got, want) {
		t.Fatalf("summary:\n got %q\nwant %q", got, want)
	}
	page, err := reader.ReadTraceWith(opencodeTestRef(), nil, 50, TraceOptions{Times: true})
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].At != 1000 || page.Items[1].At != 2100 || page.Items[2].At != 2000 || page.Items[3].At != 2200 {
		t.Fatalf("times=%d %d %d %d", page.Items[0].At, page.Items[1].At, page.Items[2].At, page.Items[3].At)
	}
	detail, err := reader.ReadTraceDetail(opencodeTestRef(), page.Items[5].DetailRef)
	if err != nil || detail.Input != `{"filePath":"/work/.env"}` || !strings.HasPrefix(detail.Output, "Error: The user rejected") {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
	history, err := reader.Read(opencodeTestRef(), nil, 50)
	if err != nil || len(history.Messages) != 6 || history.Messages[0].Text != "Which folders are here?" || history.Messages[2].Text != "工具 · bash" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	if activity := reader.ReadActivity(opencodeTestRef()); !activity.Known || len(activity.Key) != 64 {
		t.Fatalf("activity=%+v", activity)
	}
}

func TestOpencodeMarksCompactionAndAbortedTurns(t *testing.T) {
	fixture := newOpencodeFixture(t)
	fixture.message("msg_001", "user", 1000, nil)
	fixture.part("msg_001", "prt_001", map[string]any{"type": "text", "text": "Refactor it"})
	fixture.part("msg_001", "prt_002", map[string]any{"type": "text", "text": "and keep the tests"})
	fixture.message("msg_002", "assistant", 2000, map[string]any{"summary": true})
	fixture.part("msg_002", "prt_001", map[string]any{"type": "text", "text": "Summary of the conversation so far"})
	fixture.message("msg_003", "assistant", 3000, map[string]any{"error": map[string]any{"name": "MessageAbortedError"}})
	fixture.part("msg_003", "prt_001", map[string]any{"type": "text", "text": "Starting"})
	reader := &Reader{OpencodeRoot: fixture.root}
	want := []string{"user||||Refactor it\n\nand keep the tests", "compaction", "assistant||||Starting", "interrupt"}
	if got := opencodeSummary(t, reader, TraceOptions{Markers: true}); !slices.Equal(got, want) {
		t.Fatalf("with markers:\n got %q\nwant %q", got, want)
	}
	want = []string{"user||||Refactor it\n\nand keep the tests", "assistant||||Starting"}
	if got := opencodeSummary(t, reader, TraceOptions{}); !slices.Equal(got, want) {
		t.Fatalf("without markers:\n got %q\nwant %q", got, want)
	}
}

func TestOpencodeFollowsAPartThatGrowsAndKeepsEarlierOffsets(t *testing.T) {
	fixture := newOpencodeFixture(t)
	fixture.message("msg_001", "user", 1000, nil)
	fixture.part("msg_001", "prt_001", map[string]any{"type": "text", "text": "Go"})
	fixture.message("msg_002", "assistant", 2000, nil)
	fixture.tool("msg_002", "prt_001", "bash", "running", map[string]any{"input": map[string]any{"command": "make"}})
	reader := &Reader{OpencodeRoot: fixture.root}
	clock := time.Unix(1_800_000_000, 0)
	reader.now = func() time.Time { return clock }
	before, err := reader.ReadTraceSummary(opencodeTestRef(), nil, 50)
	if err != nil || before.Items[1].State != "running" {
		t.Fatalf("before=%+v err=%v", before, err)
	}
	// The same part file is rewritten when the tool ends; a new message follows.
	fixture.tool("msg_002", "prt_001", "bash", "completed", map[string]any{"input": map[string]any{"command": "make"}, "output": "built", "metadata": map[string]any{"exit": 0}})
	fixture.message("msg_003", "assistant", 3000, nil)
	fixture.part("msg_003", "prt_001", map[string]any{"type": "text", "text": "Built."})
	after, err := reader.ReadTraceSummary(opencodeTestRef(), nil, 50)
	if err != nil || len(after.Items) != 3 || after.Items[1].State != "done" || after.Items[2].Text != "Built." {
		t.Fatalf("after=%+v err=%v", after, err)
	}
	// The tool's place in the rendered session did not move, so its earlier ref still finds it.
	detail, err := reader.ReadTraceDetail(opencodeTestRef(), before.Items[1].DetailRef)
	if err != nil || detail.Output != "built" {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
}

func TestOpencodeUnknownSessionAndForeignFilesAreNotRead(t *testing.T) {
	fixture := newOpencodeFixture(t)
	reader := &Reader{OpencodeRoot: fixture.root}
	page, err := reader.ReadTrace(opencodeTestRef(), nil, 20)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("a session with no messages is an empty chat: page=%+v err=%v", page, err)
	}
	other := Ref{Source: "herdr:opencode", Agent: "opencode", Kind: "id", Value: "ses_unknownunknownunknown"}
	if _, err := reader.ReadTrace(other, nil, 20); err != ErrUnavailable {
		t.Fatalf("unknown session: %v", err)
	}
	if reader.Available(other) {
		t.Fatal("an unknown session is not available")
	}
	// A message file that links outside storage is not followed, and names that are not ids are ignored.
	secret := filepath.Join(t.TempDir(), "secret.json")
	writeJSONFile(t, secret, map[string]any{"role": "user", "time": map[string]any{"created": 1}})
	messages := filepath.Join(fixture.root, "storage", "message", opencodeTestID)
	if err := os.MkdirAll(messages, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(messages, "msg_linked.json")); err != nil {
		t.Skip("symlinks are not available")
	}
	writeJSONFile(t, filepath.Join(messages, "notes.json"), map[string]any{"role": "user"})
	fixture.part("msg_linked", "prt_001", map[string]any{"type": "text", "text": "leaked"})
	fresh := &Reader{OpencodeRoot: fixture.root}
	page, err = fresh.ReadTrace(opencodeTestRef(), nil, 20)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("a linked message was read: page=%+v err=%v", page, err)
	}
	if fresh.Supports(Ref{Source: "phone", Agent: "opencode", Kind: "id", Value: opencodeTestID}) {
		t.Fatal("untrusted source accepted")
	}
}
