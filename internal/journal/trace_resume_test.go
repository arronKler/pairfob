package journal

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func claudeTracePath(root, id string) string {
	return filepath.Join(root, "projects", "-repo", id+".jsonl")
}

func claudeTurn(text string) map[string]any {
	return map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}}
}

func claudeReply(id, text string) map[string]any {
	return map[string]any{"type": "assistant", "message": map[string]any{
		"id": id, "role": "assistant", "content": []map[string]any{{"type": "text", "text": text}},
	}}
}

func appendTraceLine(t *testing.T, path string, value any) int64 {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	line, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func readClaudePage(t *testing.T, reader *Reader, ref Ref, limit int) TracePage {
	t.Helper()
	page, err := reader.ReadTrace(ref, nil, limit)
	if err != nil {
		t.Fatal(err)
	}
	return page
}

func itemTexts(page TracePage) []string {
	texts := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		texts = append(texts, item.Text)
	}
	return texts
}

// A tail read that only saw an append must land on the same page a fresh scan
// of the whole file would: the window is continued, not rebuilt.
func TestExtendTraceWindowMatchesAFullParse(t *testing.T) {
	root := t.TempDir()
	id := "session_resume_12345678"
	path := claudeTracePath(root, id)
	writeLines(t, path, claudeTurn("first question"), claudeReply("m1", "first answer"),
		claudeTurn("second question"), claudeReply("m2", "second answer"))
	prefix, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	writeLines(t, path, claudeTurn("first question"), claudeReply("m1", "first answer"),
		claudeTurn("second question"), claudeReply("m2", "second answer"),
		claudeTurn("third question"), claudeReply("m3", "third answer"))
	full, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}

	fresh, err := readTrace(&transcript{name: path, size: int64(len(full)), reader: bytes.NewReader(full)}, ref, 0, 20, parseClaudeTrace, TraceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	prefixRead, err := readTrace(&transcript{name: path, size: int64(len(prefix)), reader: bytes.NewReader(prefix)}, ref, 0, 20, parseClaudeTrace, TraceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	extended, tail, whole, err := extendTraceWindow(prefixRead.window, full[len(prefix):], len(prefix), 20, parseClaudeTrace, TraceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !whole || tail != len(full) {
		t.Fatalf("extended tail=%d whole=%v, want %d and true", tail, whole, len(full))
	}
	got, want := extended.page(ref, prefixRead.start, prefixRead.limited), fresh.page
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("extended page differs from a full parse\n got=%s\nwant=%s", gotJSON, wantJSON)
	}
	if texts := itemTexts(got); len(texts) != 6 {
		t.Fatalf("page=%v, want six items", texts)
	}
}

func TestTraceTailResumesOnAppendAndReadsOnlyTheNewBytes(t *testing.T) {
	root := t.TempDir()
	id := "session_append_12345678"
	path := claudeTracePath(root, id)
	// A tail a full scan would read from the start of the file.
	lines := make([]any, 0, 400)
	for i := 0; i < 200; i++ {
		lines = append(lines, claudeTurn(strings.Repeat("question ", 64)), claudeReply("m"+string(rune('a'+i%26)), strings.Repeat("answer ", 64)))
	}
	writeLines(t, path, lines...)
	reader := &Reader{ClaudeRoot: root}
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	if texts := itemTexts(readClaudePage(t, reader, ref, 20)); len(texts) != 20 {
		t.Fatalf("first page has %d items", len(texts))
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	appendTraceLine(t, path, claudeTurn("second question"))
	size := appendTraceLine(t, path, claudeReply("m2", "second answer"))

	// The resumed read may touch the anchor and the appended bytes, nothing else.
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	counting := &countingReaderAt{reader: file}
	source := &transcript{name: path, size: size, modified: 2, reader: counting, file: file}
	key := traceCacheKey{limit: 20}
	for cached := range reader.traceCache {
		key = cached
	}
	page, ok := reader.resumeTracePage(key, source, ref, 20, TraceOptions{})
	if !ok {
		entry := reader.traceCache[key]
		t.Fatalf("an appended tail did not resume: entry size=%d tail=%d anchor=%d window=%d source=%d", entry.size, entry.tail, len(entry.anchor), len(entry.window.items), source.size)
	}
	if texts := itemTexts(page); len(texts) != 20 || texts[19] != "second answer" {
		t.Fatalf("resumed page has %d items, last=%q", len(texts), texts[len(texts)-1])
	}
	appended := size - before.Size()
	if counting.read > appended+2*traceCacheAnchorBytes {
		t.Fatalf("resumed read touched %d bytes for a %d byte append", counting.read, appended)
	}
}

func TestTraceTailDoesNotResumeAcrossARewrite(t *testing.T) {
	root := t.TempDir()
	id := "session_rewrite_12345678"
	path := claudeTracePath(root, id)
	writeLines(t, path, claudeTurn("first question"), claudeReply("m1", "first answer"))
	reader := &Reader{ClaudeRoot: root}
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	readClaudePage(t, reader, ref, 20)

	// A branch/reset rewrites the transcript and grows it. The cached window
	// belongs to the old history and must not be continued.
	writeLines(t, path, claudeTurn("other question"), claudeReply("n1", "other answer"),
		claudeTurn("other question two"), claudeReply("n2", "other answer two"))
	texts := itemTexts(readClaudePage(t, reader, ref, 20))
	want := []string{"other question", "other answer", "other question two", "other answer two"}
	if strings.Join(texts, "|") != strings.Join(want, "|") {
		t.Fatalf("page after rewrite=%v, want %v", texts, want)
	}
}

func TestTraceTailKeepsAPartialRecordOnce(t *testing.T) {
	root := t.TempDir()
	id := "session_partial_12345678"
	path := claudeTracePath(root, id)
	writeLines(t, path, claudeTurn("first question"), claudeReply("m1", "first answer"))
	reader := &Reader{ClaudeRoot: root}
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	readClaudePage(t, reader, ref, 20)

	// The writer is mid-line: the record has no newline yet.
	line, err := json.Marshal(claudeTurn("partially written"))
	if err != nil {
		t.Fatal(err)
	}
	appendTraceBytes(t, path, line)
	mid := itemTexts(readClaudePage(t, reader, ref, 20))
	if countText(mid, "partially written") > 1 {
		t.Fatalf("partial record shown twice: %v", mid)
	}

	appendTraceBytes(t, path, []byte("\n"))
	done := itemTexts(readClaudePage(t, reader, ref, 20))
	if countText(done, "partially written") != 1 {
		t.Fatalf("completed record counted %d times: %v", countText(done, "partially written"), done)
	}
}

func appendTraceBytes(t *testing.T, path string, data []byte) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
}

func countText(texts []string, want string) int {
	count := 0
	for _, text := range texts {
		if text == want {
			count++
		}
	}
	return count
}

type countingReaderAt struct {
	reader io.ReaderAt
	read   int64
}

func (c *countingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.reader.ReadAt(p, off)
	c.read += int64(n)
	return n, err
}
