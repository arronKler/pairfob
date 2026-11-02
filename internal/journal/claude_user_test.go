package journal

import (
	"fmt"
	"path/filepath"
	"testing"
)

const claudeTestID = "12345678-abcd-4321-abcd-1234567890ab"

func claudeTestRef() Ref {
	return Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: claudeTestID}
}

func claudeTestPath(root string) string {
	return filepath.Join(root, "projects", "-tmp-pairfob", claudeTestID+".jsonl")
}

func userEntry(content any, extra map[string]any) map[string]any {
	entry := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}
	for k, v := range extra {
		entry[k] = v
	}
	return entry
}

func queuedEntry(prompt, kind string, humanTurn bool, timestamp string) map[string]any {
	return map[string]any{"type": "attachment", "uuid": "u1", "attachment": map[string]any{
		"type": "queued_command", "origin": map[string]any{"kind": kind}, "humanTurn": humanTurn,
		"source_uuid": "s1", "timestamp": timestamp, "prompt": prompt,
	}}
}

func assistantEntry(text string) map[string]any {
	return map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": text}}
}

func readClaudeTexts(t *testing.T, entries ...map[string]any) []Message {
	t.Helper()
	root := t.TempDir()
	writeLines(t, claudeTestPath(root), anyEntries(entries)...)
	page, err := (&Reader{ClaudeRoot: root}).Read(claudeTestRef(), nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	return page.Messages
}

func TestClaudeHistoryShowsHumanQueuedCommand(t *testing.T) {
	got := readClaudeTexts(t,
		userEntry("first", nil),
		queuedEntry("queued while busy", "human", true, "2026-01-01T00:00:05.123456789Z"),
		assistantEntry("answer"),
	)
	if len(got) != 3 || got[0].Text != "first" || got[1] != (Message{Role: "user", Text: "queued while busy"}) || got[2].Text != "answer" {
		t.Fatalf("messages=%+v", got)
	}
}

func TestClaudeHistoryIgnoresNonHumanQueuedCommands(t *testing.T) {
	got := readClaudeTexts(t,
		queuedEntry("from peer", "peer", true, "2026-01-01T00:00:00Z"),
		queuedEntry("from task", "task-notification", true, "2026-01-01T00:00:00Z"),
		queuedEntry("not a human turn", "human", false, "2026-01-01T00:00:00Z"),
		queuedEntry("", "human", true, "2026-01-01T00:00:00Z"),
		map[string]any{"type": "attachment", "attachment": map[string]any{"type": "other", "prompt": "x"}},
	)
	if len(got) != 0 {
		t.Fatalf("messages=%+v", got)
	}
}

func TestClaudeHistoryDropsInjectedUserText(t *testing.T) {
	got := readClaudeTexts(t,
		userEntry("<task-notification>done</task-notification>", nil),
		userEntry("  \n<cross-session-message from=x>hi", nil),
		userEntry("<system-reminder>remember</system-reminder>", nil),
		userEntry("<local-command-stdout>ok</local-command-stdout>", nil),
		userEntry("<command-name>/compact</command-name>", nil),
		userEntry("<command-message>compact</command-message>", nil),
		userEntry("<command-args></command-args>", nil),
		userEntry("<bash-input>ls</bash-input>", nil),
		userEntry("<bash-stdout>a</bash-stdout>", nil),
		userEntry("<bash-stderr>b</bash-stderr>", nil),
		userEntry("meta text", map[string]any{"isMeta": true}),
		userEntry("tagged", map[string]any{"origin": map[string]any{"kind": "task-notification"}}),
	)
	if len(got) != 0 {
		t.Fatalf("messages=%+v", got)
	}
}

func TestClaudeHistoryDropsCompactSummary(t *testing.T) {
	got := readClaudeTexts(t,
		userEntry("long summary", map[string]any{"isCompactSummary": true}),
		userEntry("transcript only", map[string]any{"isVisibleInTranscriptOnly": true}),
		userEntry("This session is being continued from a previous conversation that ran out of context.", nil),
	)
	if len(got) != 0 {
		t.Fatalf("messages=%+v", got)
	}
	kept := readClaudeTexts(t, userEntry("note: This session is being continued from a previous conversation", nil))
	if len(kept) != 1 {
		t.Fatalf("phrase after other words: %+v", kept)
	}
}

func TestClaudeHistoryKeepsTextBesideInjectedBlock(t *testing.T) {
	got := readClaudeTexts(t, userEntry([]map[string]any{
		{"type": "text", "text": "<system-reminder>x</system-reminder>"},
		{"type": "text", "text": "plain words"},
	}, nil))
	if len(got) != 1 || got[0].Text != "plain words" {
		t.Fatalf("messages=%+v", got)
	}
}

func TestClaudeHistoryShowsQueuedPromptOnce(t *testing.T) {
	near := readClaudeTexts(t,
		queuedEntry("same", "human", true, "2026-01-01T00:00:00Z"),
		userEntry("same", map[string]any{"timestamp": "2026-01-01T00:00:10Z"}),
	)
	if len(near) != 1 {
		t.Fatalf("10s apart: %+v", near)
	}
	far := readClaudeTexts(t,
		queuedEntry("same", "human", true, "2026-01-01T00:00:00Z"),
		userEntry("same", map[string]any{"timestamp": "2026-01-01T00:02:00Z"}),
	)
	if len(far) != 2 {
		t.Fatalf("2min apart: %+v", far)
	}
}

func TestClaudeTraceShowsQueuedAndDropsInjected(t *testing.T) {
	root := t.TempDir()
	writeLines(t, claudeTestPath(root),
		queuedEntry("queued ask", "human", true, "2026-01-01T00:00:00Z"),
		userEntry("<task-notification>x</task-notification>", nil),
		userEntry("summary", map[string]any{"isCompactSummary": true}),
		assistantEntry("calling"),
		map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{
			{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": map[string]any{}},
		}}},
		userEntry([]map[string]any{{"type": "tool_result", "tool_use_id": "toolu_1", "content": "out"}}, nil),
	)
	page, err := (&Reader{ClaudeRoot: root}).ReadTrace(claudeTestRef(), nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 3 || page.Items[0].Type != "user" || page.Items[0].Text != "queued ask" ||
		page.Items[1].Type != "assistant" || page.Items[2].Type != "tool" || page.Items[2].Output != "out" {
		t.Fatalf("items=%+v", page.Items)
	}
}

func TestClaudeHistoryPagingWithQueuedCommands(t *testing.T) {
	var entries []map[string]any
	var want []string
	for i := range 3 {
		q := fmt.Sprintf("queued %d", i)
		a := fmt.Sprintf("answer %d", i)
		entries = append(entries, queuedEntry(q, "human", true, "2026-01-01T00:00:00Z"), assistantEntry(a),
			userEntry("<system-reminder>r</system-reminder>", nil))
		want = append(want, q, a)
	}
	root := t.TempDir()
	writeLines(t, claudeTestPath(root), anyEntries(entries)...)
	reader := &Reader{ClaudeRoot: root}
	var got []string
	var cursor *string
	for range 10 {
		page, err := reader.Read(claudeTestRef(), cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range page.Messages {
			got = append(got, m.Text)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got=%v want=%v", got, want)
	}
}

func anyEntries(entries []map[string]any) []any {
	out := make([]any, len(entries))
	for i, e := range entries {
		out[i] = e
	}
	return out
}

const pastedBlock = "<pasted_content id=\"34e0\">\na\nb\n</pasted_content id=\"34e0\">"

func TestClaudeHistoryPairsQueuedPromptWithPastedContentEntry(t *testing.T) {
	got := readClaudeTexts(t,
		queuedEntry("a\nb", "human", true, "2026-01-01T00:00:00Z"),
		userEntry(pastedBlock, map[string]any{"timestamp": "2026-01-01T00:00:20Z"}),
	)
	if len(got) != 1 || got[0] != (Message{Role: "user", Text: "a\nb"}) {
		t.Fatalf("messages=%+v", got)
	}
}

func TestClaudeUserTextKeepsWordsAroundPastedContent(t *testing.T) {
	text := "before\n" + pastedBlock + "\nafter"
	got := readClaudeTexts(t, userEntry(text, nil))
	if len(got) != 1 || got[0].Text != "before\na\nb\nafter" {
		t.Fatalf("history=%+v", got)
	}
	root := t.TempDir()
	writeLines(t, claudeTestPath(root), userEntry([]map[string]any{{"type": "text", "text": text}}, nil))
	page, err := (&Reader{ClaudeRoot: root}).ReadTrace(claudeTestRef(), nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Text != "before\na\nb\nafter" {
		t.Fatalf("trace=%+v", page.Items)
	}
}

func TestClaudeAssistantTextKeepsPastedContentTag(t *testing.T) {
	const text = "see <pasted_content id=\"1\"> here"
	got := readClaudeTexts(t, assistantEntry(text))
	if len(got) != 1 || got[0].Text != text {
		t.Fatalf("messages=%+v", got)
	}
}

func traceUsers(t *testing.T, entries ...map[string]any) []Event {
	t.Helper()
	root := t.TempDir()
	writeLines(t, claudeTestPath(root), anyEntries(entries)...)
	page, err := (&Reader{ClaudeRoot: root}).ReadTrace(claudeTestRef(), nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	return page.Items
}

func TestClaudeTracePairsQueuedPromptWithPastedContentEntry(t *testing.T) {
	items := traceUsers(t,
		queuedEntry("a\nb", "human", true, "2026-01-01T00:00:00Z"),
		userEntry(pastedBlock, map[string]any{"timestamp": "2026-01-01T00:00:20Z"}),
	)
	if len(items) != 1 || items[0].Type != "user" || items[0].Text != "a\nb" {
		t.Fatalf("items=%+v", items)
	}
}

func TestClaudeTraceKeepsReplyBetweenPairedPrompts(t *testing.T) {
	items := traceUsers(t,
		queuedEntry("a\nb", "human", true, "2026-01-01T00:00:00Z"),
		assistantEntry("reply"),
		userEntry(pastedBlock, map[string]any{"timestamp": "2026-01-01T00:00:20Z"}),
	)
	if len(items) != 2 || items[0].Type != "user" || items[1].Text != "reply" {
		t.Fatalf("items=%+v", items)
	}
}

func TestClaudeTraceKeepsTextsMoreThanAMinuteApart(t *testing.T) {
	items := traceUsers(t,
		queuedEntry("a\nb", "human", true, "2026-01-01T00:00:00Z"),
		userEntry(pastedBlock, map[string]any{"timestamp": "2026-01-01T00:02:00Z"}),
	)
	if len(items) != 2 {
		t.Fatalf("items=%+v", items)
	}
}

func TestClaudeTraceSummaryPairsAcrossLaterRead(t *testing.T) {
	root := t.TempDir()
	path := claudeTestPath(root)
	reader := &Reader{ClaudeRoot: root}
	writeLines(t, path, queuedEntry("a\nb", "human", true, "2026-01-01T00:00:00Z"))
	first, err := reader.ReadTraceSummary(claudeTestRef(), nil, 20)
	if err != nil || len(first.Items) != 1 {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	writeLines(t, path,
		queuedEntry("a\nb", "human", true, "2026-01-01T00:00:00Z"),
		userEntry(pastedBlock, map[string]any{"timestamp": "2026-01-01T00:00:20Z"}),
	)
	second, err := reader.ReadTraceSummary(claudeTestRef(), nil, 20)
	if err != nil || len(second.Items) != 1 || second.Items[0].Text != "a\nb" {
		t.Fatalf("second=%+v err=%v", second, err)
	}
}
