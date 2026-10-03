package journal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestForEachLineSkipsOversizedLinesAndKeepsOffsets(t *testing.T) {
	input := "short\n" + strings.Repeat("x", 100) + "\nlast\r\ntail"
	type seen struct {
		line      string
		size      int
		oversized bool
	}
	var got []seen
	if err := forEachLine(strings.NewReader(input), 10, func(line []byte, size int, oversized bool) bool {
		got = append(got, seen{string(line), size, oversized})
		return true
	}); err != nil {
		t.Fatal(err)
	}
	want := []seen{{"short", 6, false}, {"", 101, true}, {"last", 6, false}, {"tail", 4, false}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d=%+v want %+v", i, got[i], want[i])
		}
	}
}

func TestOversizedToolOutputDoesNotFailTraceOrHistory(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	path := filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl")
	writeLines(t, path,
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "dump it"}},
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": "{}"}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call_output", "call_id": "c1", "output": strings.Repeat("y", maxTraceLine)}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": "done"}},
		}},
	)
	reader := &Reader{CodexRoot: root}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	summary, err := reader.ReadTraceSummary(ref, nil, 20)
	if err != nil || !summary.Truncated || len(summary.Items) != 3 || summary.Items[2].Text != "done" {
		t.Fatalf("summary=%+v err=%v", summary, err)
	}
	detail, err := reader.ReadTraceDetail(ref, summary.Items[1].DetailRef)
	if err != nil || !detail.Truncated || detail.Output != "" {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
	history, err := reader.Read(ref, nil, 20)
	if err != nil || !history.Truncated || len(history.Messages) != 3 {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	if info, _ := os.Stat(path); info.Size() <= maxTraceLine {
		t.Fatalf("fixture is not oversized: %d", info.Size())
	}
}

func TestDetailIsCompleteWhenOnlyALaterRecordIsOversized(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	writeLines(t, filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl"),
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": "{}"}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call_output", "call_id": "c1", "output": "ok"}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call_output", "call_id": "c2", "output": strings.Repeat("y", maxTraceLine)}},
	)
	reader := &Reader{CodexRoot: root}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	summary, err := reader.ReadTraceSummary(ref, nil, 20)
	if err != nil || len(summary.Items) != 1 {
		t.Fatalf("summary=%+v err=%v", summary, err)
	}
	detail, err := reader.ReadTraceDetail(ref, summary.Items[0].DetailRef)
	if err != nil || detail.Output != "ok" || detail.Truncated {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
}
