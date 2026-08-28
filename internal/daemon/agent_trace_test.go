package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

func TestAgentTraceReturnsThinkingAndToolBodies(t *testing.T) {
	root := t.TempDir()
	sessionID := "session_12345678"
	transcript := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"reasoning","content":[{"type":"reasoning_text","text":"need the file"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"function_call","name":"Read","call_id":"c1","arguments":"{\"path\":\"/secret\"}"}}` + "\n" +
		`{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"private"}}` + "\n"
	if err := os.WriteFile(transcript, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := runtime.NewFake()
	fake.Snap.Panes[0].Agent = "codex"
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: sessionID}
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = &journal.Reader{CodexRoot: root}

	raw, err := client.RPC("AgentTrace", map[string]any{"pane_id": "w0:p1", "limit": 20})
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, raw)
	items, ok := result["items"].([]any)
	if !ok || len(items) != 3 {
		t.Fatalf("unexpected trace: %s", raw)
	}
	encoded := string(raw)
	if !strings.Contains(encoded, `"type":"thinking"`) || !strings.Contains(encoded, "need the file") {
		t.Fatalf("thinking missing: %s", raw)
	}
	if !strings.Contains(encoded, `"type":"tool"`) || !strings.Contains(encoded, "/secret") || !strings.Contains(encoded, "private") {
		t.Fatalf("tool body missing: %s", raw)
	}
	if _, err := client.RPC("AgentTrace", map[string]any{"pane_id": "missing", "limit": 20}); err == nil || err.Error() != "pane_not_found" {
		t.Fatalf("missing pane: %v", err)
	}
}

func TestAgentTraceClipsLargeEscapedToolOutputToEnvelope(t *testing.T) {
	root := t.TempDir()
	sessionID := "session_large_12345678"
	transcript := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	records := []map[string]any{
		{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "inspect"}}}},
		{"type": "response_item", "payload": map[string]any{"type": "function_call", "name": "Read", "call_id": "c1", "arguments": `{"path":"large"}`}},
		{"type": "response_item", "payload": map[string]any{"type": "function_call_output", "call_id": "c1", "output": strings.Repeat("\\\n", 120_000)}},
	}
	var lines strings.Builder
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		lines.Write(encoded)
		lines.WriteByte('\n')
	}
	if err := os.WriteFile(transcript, []byte(lines.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	fake := runtime.NewFake()
	fake.Snap.Panes[0].Agent = "codex"
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: sessionID}
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = &journal.Reader{CodexRoot: root}

	raw, err := client.RPC("AgentTrace", map[string]any{"pane_id": "w0:p1", "limit": 200})
	if err != nil {
		t.Fatalf("large trace should be clipped instead of rejected: %v", err)
	}
	if len(raw) > maxReplyText {
		t.Fatalf("trace result exceeded reply budget: %d", len(raw))
	}
	var page journal.TracePage
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	if !page.Truncated || len(page.Items) != 2 || page.Items[1].Output == "" {
		t.Fatalf("large tool output was not represented safely: %+v", page)
	}
}

func TestAgentTraceRejectsUntrustedBinding(t *testing.T) {
	fake := runtime.NewFake()
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = &journal.Reader{CodexRoot: t.TempDir()}
	if _, err := client.RPC("AgentTrace", map[string]any{"pane_id": "w0:p1", "limit": 20}); err == nil || err.Error() != "transcript_unavailable" {
		t.Fatalf("unbound pane leaked a trace: %v", err)
	}
}
