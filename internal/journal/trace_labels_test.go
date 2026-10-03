package journal

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestToolLabelDerivesOneLineHints(t *testing.T) {
	long := strings.Repeat("长", 200)
	for _, tc := range []struct {
		name, tool, input, want string
	}{
		{"claude plan", "TodoWrite", `{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"in_progress"},{"content":"c","status":"pending"}]}`, "1/3"},
		{"codex plan", "update_plan", `{"explanation":"x","plan":[{"step":"a","status":"completed"},{"step":"b","status":"completed"}]}`, "2/2"},
		{"empty plan falls through", "update_plan", `{"plan":[],"description":"none yet"}`, "none yet"},
		{"claude question", "AskUserQuestion", `{"questions":[{"question":"Which port?","options":[]},{"question":"second"}]}`, "Which port?"},
		{"codex question", "request_user_input_async", `{"questions":[{"title":"这条提示出现在哪台电脑？","options":["a"]}]}`, "这条提示出现在哪台电脑？"},
		{"command first line", "Bash", `{"command":"\n  go test ./internal/journal\necho done","description":"Run tests"}`, "go test ./internal/journal"},
		{"cmd", "exec_command", `{"cmd":"rg -n label internal","yield_time_ms":1000}`, "rg -n label internal"},
		{"argv uses last element", "shell", `{"command":["bash","-lc","git status\ngit diff"]}`, "git status"},
		{"script", "run", `{"script":"make check"}`, "make check"},
		{"claude path", "Read", `{"file_path":"/repo/internal/journal/trace.go","limit":20}`, "/repo/internal/journal/trace.go"},
		{"pi path", "edit", `{"path":"pwa/src/main.ts","edits":[{"oldText":"a","newText":"b"}]}`, "pwa/src/main.ts"},
		{"grok path", "read_file", `{"target_file":"/Users/a/.config/x.yaml"}`, "/Users/a/.config/x.yaml"},
		{"grok directory", "list_dir", `{"target_directory":"/Users/a/.config"}`, "/Users/a/.config"},
		{"notebook", "NotebookEdit", `{"notebook_path":"a.ipynb","new_source":"x"}`, "a.ipynb"},
		{"search pattern beats path", "Grep", `{"pattern":"TODO","path":"internal"}`, "TODO"},
		{"pattern", "Grep", `{"pattern":"func (r \\*Reader)","output_mode":"content"}`, "func (r \\*Reader)"},
		{"query", "WebSearch", `{"query":"go 1.26 release notes"}`, "go 1.26 release notes"},
		{"url", "WebFetch", `{"url":"https://example.com/a","prompt":"summarize"}`, "https://example.com/a"},
		{"description", "Agent", `{"description":"Audit trace reader","prompt":"...","subagent_type":"Explore"}`, "Audit trace reader"},
		{"raw patch", "apply_patch", "*** Begin Patch\n*** Update File: internal/journal/trace.go\n@@\n-a\n+b\n*** Add File: internal/journal/x.go\n+package x\n*** Delete File: old.go\n*** End Patch\n", "internal/journal/trace.go +2"},
		{"raw patch one file", "apply_patch", "*** Begin Patch\n*** Delete File: old.go\n*** End Patch", "old.go"},
		{"json patch", "apply_patch", `{"input":"*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch"}`, "a.txt"},
		{"code mode names its first command", "exec", "text(await tools.exec_command({cmd:\"ls\"}))", "ls"},
		{"no useful key", "write_stdin", `{"session_id":1,"chars":""}`, ""},
		{"non-string value", "Read", `{"file_path":7}`, ""},
		{"blank value skipped", "Read", `{"file_path":"  ","pattern":"x"}`, "x"},
		{"empty input", "Skill", ``, ""},
		{"controls stripped", "Bash", `{"command":"echo \u001b[31mred\u0007\tdone"}`, "echo [31mred done"},
		{"line separators flattened", "Grep", `{"pattern":"a\u2028b"}`, "a b"},
		{"clipped to 160 runes", "Read", `{"file_path":"` + long + `"}`, strings.Repeat("长", 159) + "…"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := toolLabel(tc.tool, tc.input)
			if got != tc.want {
				t.Fatalf("toolLabel(%s)=%q, want %q", tc.tool, got, tc.want)
			}
			if utf8.RuneCountInString(got) > maxTraceLabelRunes || strings.ContainsAny(got, "\n\r\t") {
				t.Fatalf("label is not one bounded line: %q", got)
			}
		})
	}
}

func TestTraceSummaryLabelsAreOptIn(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	writeLines(t, filepath.Join(root, "sessions", "2026", "10", "03", "rollout-"+id+".jsonl"),
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "fix it"}},
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call", "name": "update_plan", "call_id": "call_plan", "arguments": `{"plan":[{"step":"a","status":"completed"},{"step":"b","status":"pending"}]}`,
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call", "name": "exec_command", "call_id": "call_1", "arguments": `{"cmd":"go test ./...\necho ok"}`,
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "function_call_output", "call_id": "call_1", "output": "Chunk ID: a\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\nok",
		}},
		map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_2", "input": "*** Begin Patch\n*** Update File: a.go\n*** Update File: b.go\n*** End Patch",
		}},
	)
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	reader := &Reader{CodexRoot: root}
	plain, err := reader.ReadTraceSummary(ref, nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if encoded, _ := json.Marshal(plain); strings.Contains(string(encoded), `"label"`) {
		t.Fatalf("label without opt-in: %s", encoded)
	}
	labelled, err := reader.ReadTraceSummaryWith(ref, nil, 20, TraceOptions{Labels: true})
	if err != nil || len(labelled.Items) != len(plain.Items) {
		t.Fatalf("labelled=%+v err=%v", labelled, err)
	}
	var labels []string
	for i, item := range labelled.Items {
		if item.DetailRef != plain.Items[i].DetailRef {
			t.Fatalf("detail ref changed with labels: %q != %q", item.DetailRef, plain.Items[i].DetailRef)
		}
		if item.Type == "tool" {
			labels = append(labels, item.Label)
		} else if item.Label != "" {
			t.Fatalf("label on non-tool item: %+v", item)
		}
	}
	if got := strings.Join(labels, "|"); got != "1/2|go test ./...|a.go +1" {
		t.Fatalf("labels=%q", got)
	}
}

func TestPiTraceSummaryLabels(t *testing.T) {
	reader, ref, _ := piFixture(t,
		msg("user0001", nil, "user", []any{map[string]any{"type": "text", "text": "check"}}),
		msg("asst0001", "user0001", "assistant", []any{
			map[string]any{"type": "toolCall", "id": "call-1", "name": "bash", "arguments": map[string]any{"command": "ls -la"}},
			map[string]any{"type": "toolCall", "id": "call-2", "name": "read", "arguments": map[string]any{"path": "/work/a.go"}},
		}),
	)
	page, err := reader.ReadTraceSummaryWith(ref, nil, 20, TraceOptions{Labels: true})
	if err != nil {
		t.Fatal(err)
	}
	var labels []string
	for _, item := range page.Items {
		if item.Type == "tool" {
			labels = append(labels, item.Label)
		}
	}
	if got := strings.Join(labels, "|"); got != "ls -la|/work/a.go" {
		t.Fatalf("pi labels=%q", got)
	}
}

func TestSummaryLabelsDropOldestToFitPageBudget(t *testing.T) {
	items := []TraceSummaryItem{
		{Type: "tool", Name: "Read", DetailRef: "r1", Label: strings.Repeat("a", 150)},
		{Type: "assistant", Text: strings.Repeat("x", maxTraceItemsBytes-300)},
		{Type: "tool", Name: "Read", DetailRef: "r2", Label: strings.Repeat("b", 150)},
	}
	fitSummaryExtras(items)
	if items[0].Label != "" || items[2].Label == "" {
		t.Fatalf("labels=%q,%q", items[0].Label, items[2].Label)
	}
	total := 0
	for _, item := range items {
		total += summaryItemSize(item)
	}
	if total > maxTraceItemsBytes {
		t.Fatalf("summary bytes=%d over budget", total)
	}
}

func TestSearchLabelsPreferThePatternAndSkillsTheirName(t *testing.T) {
	cases := map[string][2]string{
		"grep with path": {"Grep", `{"pattern":"isMeta","path":"internal/journal"}`},
		"grok grep":      {"grep", `{"regex":"globalConfig","path":"/Users/me"}`},
		"skill":          {"Skill", `{"skill":"ego-browser","args":""}`},
	}
	want := map[string]string{"grep with path": "isMeta", "grok grep": "globalConfig", "skill": "ego-browser"}
	for name, c := range cases {
		if got := toolLabel(c[0], c[1]); got != want[name] {
			t.Fatalf("%s: got %q want %q", name, got, want[name])
		}
	}
}

func TestCodexCodeModeLabelsNameTheFirstCall(t *testing.T) {
	cases := map[string]string{
		`text(await tools.exec_command({cmd:"rg -n 'machine' README.md | head -180","max_output_tokens":6500}));`:                             "rg -n 'machine' README.md | head -180",
		"const results = await Promise.allSettled([\ntools.exec_command({cmd:\"cat a\\nsed -n 1p b\"}),\ntools.exec_command({cmd:\"ls\"})]);": "cat a +1",
		`text(await tools.web__run({open:[{ref_id:"https://example.com/post/"}],response_length:"long"}));`:                                   "web__run · https://example.com/post/",
		`text(await tools.web__run({search_query:[{q:'"exact phrase"' }]}));`:                                                                 `web__run · "exact phrase"`,
		`console.log(1)`: "",
	}
	for code, want := range cases {
		if got := toolLabel("exec", code); got != want {
			t.Fatalf("toolLabel(exec, %q) = %q, want %q", code, got, want)
		}
	}
}
