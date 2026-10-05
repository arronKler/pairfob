package journal

import (
	"path/filepath"
	"slices"
	"testing"
)

const cursorTestID = "9596adbe-4b90-481d-ade2-99c2ca70bf7a"

func cursorTestRef() Ref {
	return Ref{Source: "herdr:cursor", Agent: "cursor", Kind: "id", Value: cursorTestID}
}

func cursorTestPath(root, project string) string {
	return filepath.Join(root, "projects", project, "agent-transcripts", cursorTestID, cursorTestID+".jsonl")
}

func cursorMessage(role string, blocks ...map[string]any) map[string]any {
	return map[string]any{"role": role, "message": map[string]any{"content": blocks}}
}

func cursorText(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

func cursorTool(name string, input map[string]any) map[string]any {
	return map[string]any{"type": "tool_use", "name": name, "input": input}
}

// The shapes below are the Cursor CLI's own (cursor-agent 2026.08.11).
func cursorTurn() []any {
	return []any{
		cursorMessage("user", cursorText("<timestamp>Monday, Oct 5, 2026, 8:08 AM (UTC+8)</timestamp>\n<user_query>\nRead note.txt, then list the folder.\n</user_query>")),
		cursorMessage("assistant", cursorText("Reading the note first."), cursorTool("Read", map[string]any{"path": "/work/repo/note.txt"})),
		cursorMessage("assistant", cursorTool("Shell", map[string]any{"command": "ls -la", "description": "List files"}),
			cursorTool("Glob", map[string]any{"glob_pattern": "*.txt", "target_directory": "/work/repo"})),
	}
}

func TestCursorHistoryShowsTheTypedPromptAndToolNames(t *testing.T) {
	root := t.TempDir()
	writeLines(t, cursorTestPath(root, "work-repo"), append(cursorTurn(),
		cursorMessage("assistant", cursorText("Done.")), map[string]any{"type": "turn_ended", "status": "success"})...)
	reader := &Reader{CursorRoot: root}
	page, err := reader.Read(cursorTestRef(), nil, 20)
	if err != nil || len(page.Messages) != 4 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	if page.Messages[0] != (Message{Role: "user", Text: "Read note.txt, then list the folder."}) {
		t.Fatalf("prompt=%+v", page.Messages[0])
	}
	if page.Messages[1].Text != "Reading the note first.\n工具 · Read" || page.Messages[2].Text != "工具 · Shell\n工具 · Glob" {
		t.Fatalf("assistant=%+v", page.Messages[1:3])
	}
	if !reader.Available(cursorTestRef()) {
		t.Fatal("a readable transcript is available")
	}
	if reader.Supports(Ref{Source: "herdr:cursor", Agent: "cursor", Kind: "path", Value: cursorTestPath(root, "work-repo")}) {
		t.Fatal("path binding must fail closed")
	}
	if reader.Supports(Ref{Source: "phone", Agent: "cursor", Kind: "id", Value: cursorTestID}) {
		t.Fatal("untrusted source accepted")
	}
}

func TestCursorToolsFinishWhenALaterRecordExists(t *testing.T) {
	root := t.TempDir()
	path := cursorTestPath(root, "work-repo")
	reader := &Reader{CursorRoot: root}
	states := func() []string {
		t.Helper()
		page, err := reader.ReadTraceSummaryWith(cursorTestRef(), nil, 20, TraceOptions{Labels: true})
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, item := range page.Items {
			if item.Type == "tool" {
				out = append(out, item.Name+":"+item.Label+":"+item.State)
			}
		}
		return out
	}
	// The newest record's tools may still be running; Cursor records no result.
	writeLines(t, path, cursorTurn()...)
	want := []string{"Read:/work/repo/note.txt:done", "Shell:ls -la:running", "Glob:*.txt:running"}
	if got := states(); !slices.Equal(got, want) {
		t.Fatalf("live turn: got %v want %v", got, want)
	}
	// The end of the turn is the only evidence they finished.
	writeLines(t, path, append(cursorTurn(), map[string]any{"type": "turn_ended", "status": "success"})...)
	want = []string{"Read:/work/repo/note.txt:done", "Shell:ls -la:done", "Glob:*.txt:done"}
	if got := states(); !slices.Equal(got, want) {
		t.Fatalf("ended turn: got %v want %v", got, want)
	}
}

func TestCursorOlderPageNeverLeavesAToolRunning(t *testing.T) {
	root := t.TempDir()
	writeLines(t, cursorTestPath(root, "work-repo"), append(cursorTurn(),
		cursorMessage("user", cursorText("<user_query>\nAgain.\n</user_query>")), cursorMessage("assistant", cursorText("Nothing changed.")))...)
	reader := &Reader{CursorRoot: root}
	newest, err := reader.ReadTraceSummaryWith(cursorTestRef(), nil, 2, TraceOptions{})
	if err != nil || newest.NextCursor == nil {
		t.Fatalf("newest=%+v err=%v", newest, err)
	}
	older, err := reader.ReadTraceSummaryWith(cursorTestRef(), newest.NextCursor, 20, TraceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	tools := 0
	for _, item := range older.Items {
		if item.Type != "tool" {
			continue
		}
		tools++
		if item.State != "done" {
			t.Fatalf("older tool still %s: %+v", item.State, item)
		}
	}
	if tools != 3 {
		t.Fatalf("older page tools=%d items=%+v", tools, older.Items)
	}
}

func TestCursorTraceDetailReturnsTheToolInput(t *testing.T) {
	root := t.TempDir()
	writeLines(t, cursorTestPath(root, "work-repo"), cursorTurn()...)
	reader := &Reader{CursorRoot: root}
	page, err := reader.ReadTraceSummary(cursorTestRef(), nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	var ref string
	for _, item := range page.Items {
		if item.Name == "Shell" {
			ref = item.DetailRef
		}
	}
	detail, err := reader.ReadTraceDetail(cursorTestRef(), ref)
	if err != nil || detail.Input != `{"command":"ls -la","description":"List files"}` || detail.Output != "" {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
}

func TestCursorContextOnlyMessagesAreNotPrompts(t *testing.T) {
	cases := map[string]string{
		"<timestamp>Monday</timestamp>\n<user_query>\nFix the bug\n</user_query>":  "Fix the bug",
		"<timestamp>Monday</timestamp>\n<attached_files>\na.ts\n</attached_files>": "",
		"<timestamp>Monday</timestamp>\nplain words":                               "plain words",
		"plain words": "plain words",
		"<user_query>\nLook at <div> in a.html\n</user_query>": "Look at <div> in a.html",
	}
	for text, want := range cases {
		if got := visibleCursorUserText(text); got != want {
			t.Errorf("%q: got %q want %q", text, got, want)
		}
	}
	if events := parseCursorTrace([]byte(`{"role":"user","message":{"content":[{"type":"text","text":"<attached_files>\na.ts\n</attached_files>"}]}}`)); len(events) != 1 || events[0].Type != "" {
		t.Fatalf("context-only record must only settle: %+v", events)
	}
}

func TestCursorTranscriptMustBeUniqueAndInsideItsRoot(t *testing.T) {
	root := t.TempDir()
	reader := &Reader{CursorRoot: root}
	if _, err := reader.ReadTrace(cursorTestRef(), nil, 20); err != ErrUnavailable {
		t.Fatalf("missing transcript: %v", err)
	}
	writeLines(t, cursorTestPath(root, "one"), cursorTurn()...)
	writeLines(t, cursorTestPath(root, "two"), cursorTurn()...)
	if _, err := reader.ReadTrace(cursorTestRef(), nil, 20); err != ErrUnavailable {
		t.Fatalf("an id in two projects is ambiguous: %v", err)
	}
	if activity := reader.ReadActivity(cursorTestRef()); activity.Known {
		t.Fatalf("an ambiguous transcript is not evidence: %+v", activity)
	}
}

func TestCursorActivityIsKnownOnceThePromptIsRecorded(t *testing.T) {
	root := t.TempDir()
	writeLines(t, cursorTestPath(root, "work-repo"), cursorTurn()...)
	activity := (&Reader{CursorRoot: root}).ReadActivity(cursorTestRef())
	if !activity.Known || len(activity.Key) != 64 {
		t.Fatalf("activity=%+v", activity)
	}
}
