package journal

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func eventTypes(page TracePage) []string {
	out := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		out = append(out, item.Type)
	}
	return out
}

func TestCodexTraceKeepsThinkingAndToolBodies(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+id+".jsonl")
	writeLines(t, path,
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []map[string]any{
				{"type": "input_text", "text": "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"},
				{"type": "input_text", "text": "please inspect"},
			},
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "reasoning", "content": []map[string]any{{"type": "reasoning_text", "text": "I should read the file"}},
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call", "name": "exec_command", "call_id": "call_1", "arguments": `{"cmd":"ls","token":"secret"}`,
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call_output", "call_id": "call_1", "output": "secret output",
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": "done"}},
		}},
	)
	page, err := (&Reader{CodexRoot: root}).ReadTrace(Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}, nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 4 {
		t.Fatalf("items=%v types=%v", page.Items, eventTypes(page))
	}
	if page.Items[0].Type != "user" || page.Items[0].Text != "please inspect" {
		t.Fatalf("user=%+v", page.Items[0])
	}
	if page.Items[1].Type != "thinking" || page.Items[1].Text != "I should read the file" {
		t.Fatalf("thinking=%+v", page.Items[1])
	}
	if page.Items[2].Type != "tool" || page.Items[2].Name != "exec_command" || !strings.Contains(page.Items[2].Input, "secret") || page.Items[2].Output != "secret output" {
		t.Fatalf("tool=%+v", page.Items[2])
	}
	if page.Items[3].Type != "assistant" || page.Items[3].Text != "done" {
		t.Fatalf("assistant=%+v", page.Items[3])
	}
}

func TestClaudeTraceKeepsThinkingAndToolBodies(t *testing.T) {
	root := t.TempDir()
	id := "12345678-abcd-4321-abcd-1234567890ab"
	path := filepath.Join(root, "projects", "-tmp-pairfob", id+".jsonl")
	writeLines(t, path,
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "please inspect"}},
		map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{
			{"type": "thinking", "thinking": "hidden chain of thought"},
			{"type": "text", "text": "I will inspect it"},
			{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": map[string]any{"file_path": "/secret"}},
		}}},
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []map[string]any{
			{"type": "tool_result", "tool_use_id": "toolu_1", "content": "private file contents"},
		}}},
	)
	page, err := (&Reader{ClaudeRoot: root}).ReadTrace(Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}, nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 4 {
		t.Fatalf("items=%v types=%v", page.Items, eventTypes(page))
	}
	if page.Items[1].Type != "thinking" || page.Items[1].Text != "hidden chain of thought" {
		t.Fatalf("thinking=%+v", page.Items[1])
	}
	if page.Items[3].Type != "tool" || page.Items[3].Name != "Read" || !strings.Contains(page.Items[3].Input, "/secret") || page.Items[3].Output != "private file contents" {
		t.Fatalf("tool=%+v", page.Items[3])
	}
}

func TestGrokTraceMergesChunksAndToolUpdates(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "project", "session_abcdefgh", "updates.jsonl")
	chunk := func(kind, text string) map[string]any {
		return map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": kind, "content": map[string]any{"type": "text", "text": text},
		}}}
	}
	writeLines(t, path,
		chunk("user_message_chunk", "hel"),
		chunk("user_message_chunk", "lo"),
		chunk("agent_thought_chunk", "think "),
		chunk("agent_thought_chunk", "hard"),
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "read_file",
			"rawInput": map[string]any{"target_file": "/secret"},
			"_meta":    map[string]any{"x.ai/tool": map[string]any{"name": "read_file"}},
		}}},
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
			"content": []map[string]any{{"type": "content", "content": map[string]any{"type": "text", "text": "file body"}}},
		}}},
		chunk("agent_message_chunk", "done"),
	)
	page, err := (&Reader{GrokRoot: root}).ReadTrace(Ref{Source: "herdr:grok", Agent: "grok", Kind: "id", Value: "session_abcdefgh"}, nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 4 {
		t.Fatalf("items=%v types=%v", page.Items, eventTypes(page))
	}
	if page.Items[0].Text != "hello" || page.Items[1].Text != "think hard" {
		t.Fatalf("merged chunks=%+v", page.Items)
	}
	if page.Items[2].Type != "tool" || page.Items[2].Name != "read_file" || !strings.Contains(page.Items[2].Input, "/secret") || page.Items[2].Output != "file body" {
		t.Fatalf("tool=%+v", page.Items[2])
	}
}

func TestGrokTraceMarksCompletedToolsWithoutBodies(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "project", "session_abcdefgh", "updates.jsonl")
	writeLines(t, path,
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "web_fetch",
			"rawInput": map[string]any{"url": "https://example.com"},
		}}},
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
		}}},
	)
	page, err := (&Reader{GrokRoot: root}).ReadTrace(Ref{Source: "herdr:grok", Agent: "grok", Kind: "id", Value: "session_abcdefgh"}, nil, 20)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	if page.Items[0].Type != "tool" || page.Items[0].Name != "web_fetch" || page.Items[0].Output != "完成" {
		t.Fatalf("tool=%+v", page.Items[0])
	}

	writeLines(t, path,
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "web_fetch",
			"rawInput": map[string]any{"url": "https://example.com"},
		}}},
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
		}}},
		map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
			"content": []map[string]any{{"type": "content", "content": map[string]any{"type": "text", "text": "page body"}}},
		}}},
	)
	page, err = (&Reader{GrokRoot: root}).ReadTrace(Ref{Source: "herdr:grok", Agent: "grok", Kind: "id", Value: "session_abcdefgh"}, nil, 20)
	if err != nil || len(page.Items) != 1 || page.Items[0].Output != "page body" {
		t.Fatalf("later body was not attached: page=%+v err=%v", page, err)
	}
}

func TestTraceTailPaginationAndCursorBinding(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+id+".jsonl")
	message := func(role, text string) map[string]any {
		kind := "input_text"
		if role == "assistant" {
			kind = "output_text"
		}
		return map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": role, "content": []map[string]any{{"type": kind, "text": text}},
		}}
	}
	writeLines(t, path, message("user", "one"), message("assistant", "two"), message("user", "three"))
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	page, err := (&Reader{CodexRoot: root}).ReadTrace(ref, nil, 2)
	if err != nil || len(page.Items) < 2 || page.Items[len(page.Items)-2].Text != "two" || page.Items[len(page.Items)-1].Text != "three" || page.NextCursor == nil {
		t.Fatalf("newest page=%+v err=%v", page, err)
	}
	if page.Items[0].Type != "user" || page.Items[0].Text != "one" {
		t.Fatalf("owning user missing from newest page=%+v", page.Items)
	}
	older, err := (&Reader{CodexRoot: root}).ReadTrace(ref, page.NextCursor, 2)
	if err != nil || len(older.Items) != 1 || older.Items[0].Text != "one" || older.NextCursor != nil {
		t.Fatalf("older page=%+v err=%v", older, err)
	}
	other := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "other_12345678"}
	if _, err := (&Reader{CodexRoot: root}).ReadTrace(other, page.NextCursor, 2); !errors.Is(err, ErrCursorConflict) {
		t.Fatal("cursor from another transcript was accepted")
	}
}

func TestTraceKeepsUserWhenNewestPageStartsMidTurn(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+id+".jsonl")
	message := func(role, text string) map[string]any {
		kind := "input_text"
		if role == "assistant" {
			kind = "output_text"
		}
		return map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": role, "content": []map[string]any{{"type": kind, "text": text}},
		}}
	}
	tool := func(call string) map[string]any {
		return map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call", "name": "Read", "call_id": call, "arguments": `{"path":"a.ts"}`,
		}}
	}
	writeLines(t, path,
		message("user", "inspect this"),
		tool("c1"),
		tool("c2"),
		tool("c3"),
		message("assistant", "done"),
	)
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	page, err := (&Reader{CodexRoot: root}).ReadTrace(ref, nil, 2)
	if err != nil || len(page.Items) != 3 || page.NextCursor == nil {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	if page.Items[0].Type != "user" || page.Items[0].Text != "inspect this" {
		t.Fatalf("user=%+v", page.Items[0])
	}
	if page.Items[1].Type != "tool" || page.Items[2].Type != "assistant" || page.Items[2].Text != "done" {
		t.Fatalf("tail=%+v", page.Items)
	}
	older, err := (&Reader{CodexRoot: root}).ReadTrace(ref, page.NextCursor, 4)
	if err != nil || len(older.Items) < 2 || older.Items[0].Text != "inspect this" {
		t.Fatalf("older=%+v err=%v", older, err)
	}
}

func TestTraceOmitsEmptyCodexEnvironmentMessages(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+id+".jsonl")
	writeLines(t, path, map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "user", "content": []map[string]any{
			{"type": "input_text", "text": "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"},
		},
	}})
	page, err := (&Reader{CodexRoot: root}).ReadTrace(Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}, nil, 20)
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	encoded, _ := json.Marshal(page)
	if strings.Contains(string(encoded), "environment_context") {
		t.Fatalf("environment dump leaked: %s", encoded)
	}
}
