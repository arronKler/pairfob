package journal

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexOutputStateReadsExitCodes(t *testing.T) {
	for _, tc := range []struct {
		name, output, want string
	}{
		{"exec success", "Command: /bin/zsh -lc ls\nChunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\na b", "done"},
		{"exec failure", "Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nboom", "error"},
		{"multi-line command header", "Command: /bin/zsh -lc 'a\nb\nc'\nChunk ID: a\nProcess exited with code 1\nOutput:\n", "error"},
		{"still running", "Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 5\nOutput:\n", ""},
		{"body text is not a status", "Chunk ID: a\nProcess exited with code 0\nOutput:\nProcess exited with code 1", "done"},
		{"body status without header", "Wall time: 1 seconds\nOutput:\nProcess exited with code 1", ""},
		{"exit code header", "Exit code: 0\nWall time: 0.4 seconds\nOutput:\nSuccess.", "done"},
		{"exit code header failure", "Exit code: 1\nWall time: 0.4 seconds\nOutput:\nnope", "error"},
		{"shell metadata", `{"output":"x\n","metadata":{"exit_code":0,"duration_seconds":0.1}}`, "done"},
		{"shell metadata failure", `{"output":"x\n","metadata":{"exit_code":127,"duration_seconds":0.1}}`, "error"},
		{"code mode result", "Script completed\nWall time 0.1 seconds\nOutput:\n\n" + `{"chunk_id":"a","exit_code":127,"output":"zsh: command not found: rg\n"}`, "error"},
		{"code mode without code", "Script completed\nWall time 0.1 seconds\nOutput:\n\n" + `{"status":"fulfilled","value":{"exit_code":1}}`, ""},
		{"script failed", "Script failed\nWall time 0.3 seconds\nOutput:\n\n{}", "error"},
		{"patch verification", "apply_patch verification failed: Failed to find expected lines in a.go", "error"},
		{"plain text", "Wall time: 20.0068 seconds\nSleep completed.", ""},
		{"json without code", `{"exit_code":"1"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexOutputState(tc.output); got != tc.want {
				t.Fatalf("state=%q, want %q", got, tc.want)
			}
		})
	}
}

func TestExplicitToolStateWinsOverOutputText(t *testing.T) {
	for _, tc := range []struct {
		event Event
		want  string
	}{
		{Event{Output: "失败"}, "error"},
		{Event{Output: "失败", State: "done"}, "done"},
		{Event{Output: "all good", State: "error"}, "error"},
		{Event{State: "error"}, "error"},
		{Event{}, "running"},
		{Event{Output: "ok"}, "done"},
	} {
		if got := traceToolState(tc.event); got != tc.want {
			t.Fatalf("traceToolState(%+v)=%q, want %q", tc.event, got, tc.want)
		}
	}
}

func summaryToolStates(t *testing.T, reader *Reader, ref Ref) (string, []TraceSummaryItem) {
	t.Helper()
	page, err := reader.ReadTraceSummary(ref, nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	var states []string
	var tools []TraceSummaryItem
	for _, item := range page.Items {
		if item.Type == "tool" {
			states = append(states, item.Name+":"+item.State)
			tools = append(tools, item)
		}
	}
	return strings.Join(states, "|"), tools
}

func TestClaudeToolErrorsReachSummary(t *testing.T) {
	root := t.TempDir()
	id := "12345678-abcd-4321-abcd-1234567890ab"
	tool := func(id, name string) map[string]any {
		return map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{
			{"type": "tool_use", "id": id, "name": name, "input": map[string]any{"command": "go test"}},
		}}}
	}
	writeLines(t, filepath.Join(root, "projects", "-tmp-pairfob", id+".jsonl"),
		claudeUser("run tests", nil),
		tool("toolu_1", "Bash"),
		claudeUser([]map[string]any{{"type": "tool_result", "tool_use_id": "toolu_1", "content": "Exit code 1\nFAIL", "is_error": true}}, nil),
		tool("toolu_2", "Bash"),
		claudeUser([]map[string]any{{"type": "tool_result", "tool_use_id": "toolu_2", "content": "ok", "is_error": false}}, nil),
		tool("toolu_3", "Read"),
		claudeUser([]map[string]any{{"type": "tool_result", "tool_use_id": "toolu_3", "content": "failed"}}, nil),
		tool("toolu_4", "Bash"),
	)
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	reader := &Reader{ClaudeRoot: root}
	states, tools := summaryToolStates(t, reader, ref)
	if states != "Bash:error|Bash:done|Read:done|Bash:running" {
		t.Fatalf("states=%q", states)
	}
	detail, err := reader.ReadTraceDetail(ref, tools[0].DetailRef)
	if err != nil || detail.Output != "Exit code 1\nFAIL" {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
}

func TestCodexToolExitCodesReachSummary(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	call := func(id string) map[string]any {
		return map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call", "name": "exec_command", "call_id": id, "arguments": `{"cmd":"make"}`,
		}}
	}
	output := func(id, text string) map[string]any {
		return map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call_output", "call_id": id, "output": text,
		}}
	}
	writeLines(t, filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl"),
		call("call_1"), output("call_1", "Chunk ID: a\nProcess exited with code 2\nOutput:\nmake: *** error"),
		call("call_2"), output("call_2", "Chunk ID: b\nProcess exited with code 0\nOutput:\nok"),
		call("call_3"), output("call_3", "no status here"),
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_4", "input": "*** Begin Patch\n*** End Patch",
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "custom_tool_call_output", "call_id": "call_4", "output": `{"output":"bad patch","metadata":{"exit_code":1}}`,
		}},
	)
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	reader := &Reader{CodexRoot: root}
	states, tools := summaryToolStates(t, reader, ref)
	if states != "exec_command:error|exec_command:done|exec_command:done|apply_patch:error" {
		t.Fatalf("states=%q", states)
	}
	detail, err := reader.ReadTraceDetail(ref, tools[0].DetailRef)
	if err != nil || !strings.Contains(detail.Output, "make: *** error") {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
}
