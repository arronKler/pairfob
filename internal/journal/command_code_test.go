package journal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const commandCodeFixture = `{"type":"session","version":3,"id":"command-session-01","timestamp":"2026-10-28T00:00:00Z","cwd":"/repo"}
{"type":"message","id":"prompt01","parentId":null,"timestamp":"2026-10-28T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Fix the session title<ide-context>private file content</ide-context>"}],"meta":{"source":"user","injected":{"companions":[{"kind":"skill","text":"hidden skill"}]}}}}
{"type":"message","id":"abandon1","parentId":"prompt01","timestamp":"2026-10-28T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Abandoned branch"}]}}
{"type":"message","id":"hidden01","parentId":"prompt01","timestamp":"2026-10-28T00:00:03Z","message":{"role":"user","content":[{"type":"text","text":"hidden automation"}],"meta":{"isAutomated":true}}}
{"type":"message","id":"tools001","parentId":"hidden01","timestamp":"2026-10-28T00:00:04Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"shell","input":{"command":"go test ./..."}}]}}
{"type":"message","id":"results1","parentId":"tools001","timestamp":"2026-10-28T00:00:05Z","message":{"role":"user","content":[{"type":"text","text":"hidden hook context"},{"type":"tool_result","tool_use_id":"tool-1","is_error":true,"content":[{"type":"text","text":"test failed"}]}],"meta":{"source":"tool","hookContexts":{"secret":"hidden hook metadata"}}}}
{"type":"message","id":"finish01","parentId":"results1","timestamp":"2026-10-28T00:00:06Z","message":{"role":"assistant","content":[{"type":"text","text":"Found the issue"}]}}
{"type":"session_info","id":"rename01","parentId":"finish01","timestamp":"2026-10-28T00:00:07Z","name":"Session title repair"}
`

func commandCodeReader(t *testing.T) (*Reader, Ref, string) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "projects", "project", "command-session-01.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(commandCodeFixture), 0600); err != nil {
		t.Fatal(err)
	}
	leaf := "finish01"
	return &Reader{NativeRoots: map[string]string{"cmd": root}}, Ref{Source: "pairfob:cmd", Agent: "cmd", Kind: "id", Value: "command-session-01", Leaf: &leaf}, path
}

func TestCommandCodeTitleBranchAndTools(t *testing.T) {
	r, ref, _ := commandCodeReader(t)
	if title := r.ReadTitle(ref); title.Name != "Session title repair" || title.Prompt != "Fix the session title" {
		t.Fatalf("title: %+v", title)
	}
	page, err := r.ReadTraceWith(ref, nil, 50, TraceOptions{Labels: true})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(page)
	for _, text := range []string{"hidden", "private file", "Abandoned"} {
		if strings.Contains(string(data), text) {
			t.Fatalf("leaked %s: %s", text, data)
		}
	}
	if !strings.Contains(string(data), "shell") || !strings.Contains(string(data), "test failed") {
		t.Fatal(string(data))
	}
	summary, err := r.ReadTraceSummaryWith(ref, nil, 50, TraceOptions{Labels: true})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(summary)
	if !strings.Contains(string(encoded), `"state":"error"`) {
		t.Fatalf("missing failure state: %s", encoded)
	}
	// Rewind has changed no transcript bytes: the live selection must still win.
	leaf := "prompt01"
	ref.Leaf = &leaf
	page, err = r.ReadTraceWith(ref, nil, 50, TraceOptions{})
	data, _ = json.Marshal(page)
	if err != nil || strings.Contains(string(data), "shell") || strings.Contains(string(data), "Found the issue") {
		t.Fatalf("rewind: %s %v", data, err)
	}
	leaf = ""
	page, err = r.ReadTraceWith(ref, nil, 50, TraceOptions{})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("empty branch: %+v %v", page, err)
	}
}

func TestCommandCodeMetadataRefreshAndInvalidBindings(t *testing.T) {
	r, ref, path := commandCodeReader(t)
	plain := strings.Split(commandCodeFixture, `{"type":"session_info"`)[0]
	if err := os.WriteFile(path, []byte(plain), 0600); err != nil {
		t.Fatal(err)
	}
	clock := time.Now()
	r.now = func() time.Time { return clock }
	if title := r.ReadTitle(ref); title.Name != "" {
		t.Fatal(title)
	}
	if err := os.WriteFile(commandCodeMetaPath(path), []byte(`{"title":"Generated title"}`), 0600); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(3 * time.Second)
	if title := r.ReadTitle(ref); title.Name != "Generated title" {
		t.Fatal(title)
	}
	for _, source := range []string{"custom:cmd", "herdr:cmd", "phone"} {
		bad := ref
		bad.Source = source
		if r.Supports(bad) {
			t.Fatal(source)
		}
	}
	bad := ref
	bad.Leaf = nil
	if r.Supports(bad) {
		t.Fatal("missing live branch")
	}
	for _, change := range []string{
		strings.Replace(commandCodeFixture, `"version":3`, `"version":99`, 1),
		strings.Replace(commandCodeFixture, `"id":"command-session-01"`, `"id":"other-session-01"`, 1),
		strings.Replace(commandCodeFixture, `"parentId":"prompt01"`, `"parentId":"missing1"`, 1),
		commandCodeFixture + `{"type":"unknown","id":"unknown1","parentId":null}` + "\n",
	} {
		if _, _, err := r.parseCommandCodeSession([]byte(change), ref, path); err == nil {
			t.Fatal("accepted malformed/unknown store")
		}
	}
	leaf := "missing1"
	bad = ref
	bad.Leaf = &leaf
	if _, _, err := r.parseCommandCodeSession([]byte(commandCodeFixture), bad, path); err == nil {
		t.Fatal("unknown live leaf")
	}
}
