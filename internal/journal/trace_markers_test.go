package journal

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func traceShape(items []Event) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, strings.TrimSuffix(item.Type+":"+item.Text, ":"))
	}
	return strings.Join(parts, "|")
}

func readBothViews(t *testing.T, reader *Reader, ref Ref) (string, string) {
	t.Helper()
	legacy, err := reader.ReadTrace(ref, nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	marked, err := reader.ReadTraceWith(ref, nil, 50, TraceOptions{Markers: true})
	if err != nil {
		t.Fatal(err)
	}
	return traceShape(legacy.Items), traceShape(marked.Items)
}

func TestClaudeTraceMarkersAreOptIn(t *testing.T) {
	root := t.TempDir()
	id := "12345678-abcd-4321-abcd-1234567890ab"
	writeLines(t, filepath.Join(root, "projects", "-tmp-pairfob", id+".jsonl"),
		claudeUser("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>", nil),
		claudeUser("fix it", nil),
		map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{{"type": "text", "text": "working"}}}},
		claudeUser([]map[string]any{{"type": "text", "text": "[Request interrupted by user for tool use]"}}, nil),
		map[string]any{"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted", "compactMetadata": map[string]any{"trigger": "manual"}},
		claudeUser("Summary of earlier work", map[string]any{"isCompactSummary": true}),
		claudeUser("<bash-input>git status</bash-input>", nil),
	)
	legacy, marked := readBothViews(t, &Reader{ClaudeRoot: root}, Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id})
	if legacy != "user:/clear|user:fix it|assistant:working|user:! git status" {
		t.Fatalf("legacy=%q", legacy)
	}
	if marked != "command:/clear|user:fix it|assistant:working|interrupt|compaction|command:! git status" {
		t.Fatalf("marked=%q", marked)
	}
}

func TestCodexTraceMarksCompactionAndAbortedTurns(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	writeLines(t, filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl"),
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "long task"}},
		}},
		map[string]any{"type": "event_msg", "payload": map[string]any{"type": "turn_aborted", "turn_id": "t1", "reason": "interrupted"}},
		map[string]any{"type": "compacted", "payload": map[string]any{"message": ""}},
		map[string]any{"type": "event_msg", "payload": map[string]any{"type": "context_compacted"}},
	)
	legacy, marked := readBothViews(t, &Reader{CodexRoot: root}, Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id})
	if legacy != "user:long task" || marked != "user:long task|interrupt|compaction" {
		t.Fatalf("legacy=%q marked=%q", legacy, marked)
	}
}

func TestGrokTraceHidesSelfSubmittedPromptsAndMarksCancel(t *testing.T) {
	root := t.TempDir()
	id := "grok_session_1"
	update := func(value map[string]any) map[string]any {
		return map[string]any{"method": "session/update", "params": map[string]any{"update": value}}
	}
	writeLines(t, filepath.Join(root, "sessions", "%2Ftmp", id, "updates.jsonl"),
		update(map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": "hi"}, "_meta": map[string]any{"promptIndex": 0}}),
		update(map[string]any{"sessionUpdate": "turn_completed", "stop_reason": "cancelled"}),
		update(map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": "<system-reminder>\nBackground task completed.\n</system-reminder>"}, "_meta": map[string]any{"promptIndex": 1, "hideFromScrollback": true}}),
		update(map[string]any{"sessionUpdate": "turn_completed", "stop_reason": "end_turn"}),
	)
	reader := &Reader{GrokRoot: root}
	ref := Ref{Source: "herdr:grok", Agent: "grok", Kind: "id", Value: id}
	legacy, marked := readBothViews(t, reader, ref)
	if legacy != "user:hi" || marked != "user:hi|interrupt" {
		t.Fatalf("legacy=%q marked=%q", legacy, marked)
	}
	history, err := reader.Read(ref, nil, 20)
	if err != nil || len(history.Messages) != 1 || history.Messages[0].Text != "hi" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
}

func TestPiTraceMarksCompactionAndAbortedReplies(t *testing.T) {
	aborted := msg("asst0001", "user0001", "assistant", []any{map[string]any{"type": "text", "text": "partial"}})
	aborted["message"].(map[string]any)["stopReason"] = "aborted"
	reader, ref, _ := piFixture(t,
		msg("user0001", nil, "user", "go"),
		aborted,
		map[string]any{"type": "compaction", "id": "comp0001", "parentId": "asst0001", "summary": "earlier work", "firstKeptEntryId": "user0001", "tokensBefore": 1000},
		msg("user0002", "comp0001", "user", "again"),
	)
	legacy, marked := readBothViews(t, reader, ref)
	if legacy != "user:go|assistant:partial|user:again" {
		t.Fatalf("legacy=%q", legacy)
	}
	if marked != "user:go|assistant:partial|interrupt|compaction|user:again" {
		t.Fatalf("marked=%q", marked)
	}
}

func TestTraceTailStartingAtCommandIsComplete(t *testing.T) {
	if !traceWindowComplete(traceWindow{items: []parsedEvent{{Event: Event{Type: EventCommand, Text: "/compact"}}}}, false) {
		t.Fatal("a command opens a turn like a typed prompt")
	}
}

func TestCodexOnlyUserCancelIsAnInterrupt(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	writeLines(t, filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl"),
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "go"}},
		}},
		map[string]any{"type": "event_msg", "payload": map[string]any{"type": "turn_aborted", "reason": "replaced"}},
		map[string]any{"type": "event_msg", "payload": map[string]any{"type": "turn_aborted", "reason": "review_ended"}},
	)
	if _, marked := readBothViews(t, &Reader{CodexRoot: root}, Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}); marked != "user:go" {
		t.Fatalf("marked=%q", marked)
	}
}

func TestCommandsAndMarkersAreNotTaskActivity(t *testing.T) {
	lines := []map[string]any{
		claudeUser("<command-name>/model</command-name>\n<command-args>opus</command-args>", nil),
		claudeUser([]map[string]any{{"type": "text", "text": "[Request interrupted by user]"}}, nil),
		{"type": "system", "subtype": "compact_boundary"},
	}
	for _, line := range lines {
		encoded, _ := json.Marshal(line)
		if activityLine("claude", encoded) {
			t.Fatalf("counted as task evidence: %s", encoded)
		}
	}
}
