package journal

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func writeLines(t *testing.T, path string, values ...any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for _, value := range values {
		line, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(append(line, '\n')); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCodexHistoryPaginationAndCursorBinding(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "2026", "08", "25", "rollout-test-session_12345678.jsonl")
	message := func(role, kind, text string) map[string]any {
		return map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": role, "content": []map[string]any{{"type": kind, "text": text}},
		}}
	}
	writeLines(t, path, message("user", "input_text", "one"), map[string]any{"type": "event_msg"}, message("assistant", "output_text", "two"), message("user", "input_text", "three"))
	reader := &Reader{CodexRoot: root}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "session_12345678"}
	page, err := reader.Read(ref, nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 2 || page.Messages[0].Text != "one" || page.Messages[1].Text != "two" || page.NextCursor == nil {
		t.Fatalf("unexpected first page: %+v", page)
	}
	next, err := reader.Read(ref, page.NextCursor, 2)
	if err != nil || len(next.Messages) != 1 || next.Messages[0].Text != "three" || next.NextCursor != nil {
		t.Fatalf("unexpected second page: page=%+v err=%v", next, err)
	}
	other := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "other_12345678"}
	if _, err := reader.Read(other, page.NextCursor, 2); !errors.Is(err, ErrCursorConflict) {
		t.Fatal("cursor from another transcript was accepted")
	}
	malformed := "***"
	if _, err := reader.Read(ref, &malformed, 2); !errors.Is(err, ErrCursorInvalid) {
		t.Fatalf("malformed cursor error=%v", err)
	}
}

func TestHistoryBudgetsEscapedTextByEncodedSize(t *testing.T) {
	root := t.TempDir()
	id := "session_escaped_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "25", "rollout-"+id+".jsonl")
	text := strings.Repeat("\\\n", 120_000)
	writeLines(t, path, map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": text}},
	}})
	page, err := (&Reader{CodexRoot: root}).Read(Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}, nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > maxPageBytes || !page.Truncated || len(page.Messages) != 1 || page.Messages[0].Text == "" {
		t.Fatalf("escaped history did not fit safely: bytes=%d page=%+v", len(encoded), page)
	}
}

func TestAvailabilityRequiresResolvableTranscript(t *testing.T) {
	reader := &Reader{CodexRoot: t.TempDir()}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "missing_12345678"}
	if !reader.Supports(ref) || reader.Available(ref) {
		t.Fatalf("supports=%v available=%v", reader.Supports(ref), reader.Available(ref))
	}
	if _, err := reader.Read(ref, nil, 20); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing transcript error=%v", err)
	}
}

func TestCodexAvailabilityReusesOneBoundedDirectoryIndex(t *testing.T) {
	root := t.TempDir()
	first := "session_12345678"
	second := "session_abcdefgh"
	writeLines(t, filepath.Join(root, "sessions", "2026", "08", "25", "rollout-one-"+first+".jsonl"), map[string]any{"type": "event_msg"})
	writeLines(t, filepath.Join(root, "sessions", "2026", "08", "25", "rollout-two-"+second+".jsonl"), map[string]any{"type": "event_msg"})

	now := time.Unix(1_700_000_000, 0)
	walks := 0
	reader := &Reader{
		CodexRoot: root,
		now:       func() time.Time { return now },
		walkDir: func(path string, visit fs.WalkDirFunc) error {
			walks++
			return filepath.WalkDir(path, visit)
		},
	}
	for _, id := range []string{first, second, first} {
		ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
		if !reader.Available(ref) {
			t.Fatalf("expected %s to be available", id)
		}
	}
	if walks != 1 {
		t.Fatalf("walks=%d, want one shared directory index", walks)
	}

	now = now.Add(codexIndexTTL + time.Second)
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: first}
	if !reader.Available(ref) || walks != 2 {
		t.Fatalf("expired index was not refreshed: available=%v walks=%d", reader.Available(ref), walks)
	}
}

func TestCodexAvailabilityRefreshesMissingTranscriptWithoutRepeatedWalks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	walks := 0
	reader := &Reader{
		CodexRoot: root,
		now:       func() time.Time { return now },
		walkDir: func(path string, visit fs.WalkDirFunc) error {
			walks++
			return filepath.WalkDir(path, visit)
		},
	}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "session_12345678"}
	if reader.Available(ref) || reader.Available(ref) || walks != 1 {
		t.Fatalf("fresh negative lookup should be cached: walks=%d", walks)
	}
	writeLines(t, filepath.Join(root, "sessions", "2026", "08", "25", "rollout-new-session_12345678.jsonl"), map[string]any{"type": "event_msg"})
	if reader.Available(ref) || walks != 1 {
		t.Fatalf("index refreshed before negative ttl: walks=%d", walks)
	}
	now = now.Add(codexNegativeTTL + time.Second)
	if !reader.Available(ref) || walks != 2 {
		t.Fatalf("new transcript not discovered after negative ttl: walks=%d", walks)
	}
}

func TestCodexReadRefreshesARecentlyMissingTranscriptImmediately(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	reader := &Reader{CodexRoot: root}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "session_12345678"}
	if reader.Available(ref) {
		t.Fatal("missing transcript reported available")
	}
	message := map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": "ready"}},
	}}
	writeLines(t, filepath.Join(root, "sessions", "2026", "08", "25", "rollout-new-session_12345678.jsonl"), message)
	page, err := reader.Read(ref, nil, 20)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Text != "ready" {
		t.Fatalf("read did not refresh missing transcript: page=%+v err=%v", page, err)
	}
}

func TestCodexAvailabilityConcurrentLookupsShareIndexBuild(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	writeLines(t, filepath.Join(root, "sessions", "2026", "08", "25", "rollout-test-"+id+".jsonl"), map[string]any{"type": "event_msg"})
	walks := 0
	reader := &Reader{
		CodexRoot: root,
		walkDir: func(path string, visit fs.WalkDirFunc) error {
			walks++
			return filepath.WalkDir(path, visit)
		},
	}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !reader.Available(ref) {
				t.Errorf("transcript unavailable")
			}
		}()
	}
	wg.Wait()
	if walks != 1 {
		t.Fatalf("concurrent walks=%d, want 1", walks)
	}
}

func TestCodexIndexRejectsSymlinkAndAmbiguousMatches(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "rollout-session_12345678.jsonl")
	writeLines(t, outside, map[string]any{"type": "event_msg"})
	symlink := filepath.Join(root, "sessions", "2026", "08", "25", "rollout-session_12345678.jsonl")
	if err := os.MkdirAll(filepath.Dir(symlink), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, symlink); err != nil {
		t.Fatal(err)
	}
	symlinkRef := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "session_12345678"}
	if (&Reader{CodexRoot: root}).Available(symlinkRef) {
		t.Fatal("symlinked transcript escaped the trusted root")
	}

	ambiguousID := "session_abcdefgh"
	writeLines(t, filepath.Join(root, "sessions", "one", "rollout-a-"+ambiguousID+".jsonl"), map[string]any{"type": "event_msg"})
	writeLines(t, filepath.Join(root, "sessions", "two", "rollout-b-"+ambiguousID+".jsonl"), map[string]any{"type": "event_msg"})
	ambiguousRef := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: ambiguousID}
	if _, err := (&Reader{CodexRoot: root}).Read(ambiguousRef, nil, 20); err == nil || !strings.Contains(err.Error(), "ambiguous transcript id") {
		t.Fatalf("ambiguous transcript was not rejected: %v", err)
	}
}

func TestGrokHistoryAndUnsupportedBinding(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "project", "session_abcdefgh", "updates.jsonl")
	update := func(kind, text string) map[string]any {
		return map[string]any{"method": "session/update", "params": map[string]any{"update": map[string]any{
			"sessionUpdate": kind, "content": map[string]any{"type": "text", "text": text},
		}}}
	}
	writeLines(t, path, update("user_message_chunk", "hello"), update("agent_thought_chunk", "hidden"), update("agent_message_chunk", "world"))
	reader := &Reader{GrokRoot: root}
	ref := Ref{Source: "herdr:grok", Agent: "grok", Kind: "id", Value: "session_abcdefgh"}
	page, err := reader.Read(ref, nil, 20)
	if err != nil || len(page.Messages) != 2 || page.Messages[0].Role != "user" || page.Messages[1].Role != "assistant" {
		t.Fatalf("unexpected page=%+v err=%v", page, err)
	}
	if reader.Supports(Ref{Source: "herdr:grok", Agent: "grok", Kind: "path", Value: path}) {
		t.Fatal("path binding must fail closed")
	}
	if reader.Supports(Ref{Source: "phone", Agent: "grok", Kind: "id", Value: "session_abcdefgh"}) {
		t.Fatal("untrusted source accepted")
	}
}

func TestCodexHistoryShowsToolNamesButNotArgumentsOrOutputs(t *testing.T) {
	root := t.TempDir()
	id := "session_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "27", "rollout-"+id+".jsonl")
	writeLines(t, path,
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call", "name": "exec_command", "arguments": `{"token":"secret"}`}},
		map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call_output", "output": "secret output"}},
	)
	page, err := (&Reader{CodexRoot: root}).Read(Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}, nil, 20)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Text != "工具 · exec_command" {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}

func TestClaudeHistorySkipsThinkingAndToolResults(t *testing.T) {
	root := t.TempDir()
	id := "12345678-abcd-4321-abcd-1234567890ab"
	path := filepath.Join(root, "projects", "-tmp-pairfob", id+".jsonl")
	writeLines(t, path,
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "please inspect"}},
		map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []map[string]any{
			{"type": "thinking", "thinking": "hidden chain of thought"},
			{"type": "text", "text": "I will inspect it"},
			{"type": "tool_use", "name": "Read", "input": map[string]any{"file_path": "/secret"}},
		}}},
		map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []map[string]any{
			{"type": "tool_result", "content": "private file contents"},
		}}},
	)
	reader := &Reader{ClaudeRoot: root}
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	page, err := reader.Read(ref, nil, 20)
	if err != nil || len(page.Messages) != 2 || page.Messages[0].Text != "please inspect" || page.Messages[1].Text != "I will inspect it\n工具 · Read" {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	encoded, _ := json.Marshal(page)
	for _, hidden := range []string{"hidden chain of thought", "private file contents", "/secret"} {
		if strings.Contains(string(encoded), hidden) {
			t.Fatalf("Claude history leaked %q: %s", hidden, encoded)
		}
	}
}

func TestClipPreservesValidUTF8AndLiteralQuotes(t *testing.T) {
	text := strings.Repeat("甲", maxMessageBytes) + `"quoted"`
	clipped, truncated := clip(text, maxMessageBytes, false)
	if !truncated || !utf8.ValidString(clipped) || !strings.Contains(clipped, "甲") {
		t.Fatalf("unexpected clipped message: truncated=%v valid=%v", truncated, utf8.ValidString(clipped))
	}
}
