package journal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTraceReadsNewestTurnPastWholeFileScanBound(t *testing.T) {
	root := t.TempDir()
	id := "session_large_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "30", "rollout-"+id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	ignored := []byte(`{"type":"event_msg","padding":"` + strings.Repeat("x", 1024) + `"}` + "\n")
	for written := 0; written <= maxScanBytes+(1<<20); written += len(ignored) {
		if _, err := file.Write(ignored); err != nil {
			file.Close()
			t.Fatal(err)
		}
	}
	message := func(role, kind, text string) []byte {
		raw, marshalErr := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": role, "content": []map[string]any{{"type": kind, "text": text}},
		}})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		return append(raw, '\n')
	}
	for _, line := range [][]byte{
		message("user", "input_text", "latest question"),
		message("assistant", "output_text", "latest answer"),
	} {
		if _, err := file.Write(line); err != nil {
			file.Close()
			t.Fatal(err)
		}
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	page, err := (&Reader{CodexRoot: root}).ReadTrace(
		Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}, nil, 20,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[0].Text != "latest question" || page.Items[1].Text != "latest answer" {
		t.Fatalf("newest turn=%+v", page.Items)
	}
	if page.NextCursor == nil {
		t.Fatal("large transcript did not expose an older cursor")
	}
	_, stats, err := readTracePage(path,
		Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}, 0, 20, parseCodexTrace,
	)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ScannedBytes > traceInitialReadBytes {
		t.Fatalf("scanned=%d, want at most the initial tail window %d", stats.ScannedBytes, traceInitialReadBytes)
	}
}

func TestTraceLatestCacheIsIsolatedAndInvalidatesOnAppend(t *testing.T) {
	root := t.TempDir()
	id := "session_cache_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "30", "rollout-"+id+".jsonl")
	writeLines(t, path, map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "first"}},
	}})
	reader := &Reader{CodexRoot: root}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	first, err := reader.ReadTrace(ref, nil, 20)
	if err != nil || len(first.Items) != 1 {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	first.Items[0].Text = "caller mutation"
	cached, err := reader.ReadTrace(ref, nil, 20)
	if err != nil || cached.Items[0].Text != "first" {
		t.Fatalf("cached page leaked caller mutation: page=%+v err=%v", cached, err)
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	line, err := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": "second"}},
	}})
	if err != nil {
		file.Close()
		t.Fatal(err)
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	updated, err := reader.ReadTrace(ref, nil, 20)
	if err != nil || len(updated.Items) != 2 || updated.Items[1].Text != "second" {
		t.Fatalf("updated=%+v err=%v", updated, err)
	}
}

func BenchmarkReadTraceLargeTail(b *testing.B) {
	root := b.TempDir()
	id := "session_bench_12345678"
	path := filepath.Join(root, "sessions", "2026", "08", "30", "rollout-"+id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		b.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		b.Fatal(err)
	}
	ignored := []byte(`{"type":"event_msg","padding":"` + strings.Repeat("x", 4096) + `"}` + "\n")
	for written := 0; written < 40<<20; written += len(ignored) {
		if _, err := file.Write(ignored); err != nil {
			file.Close()
			b.Fatal(err)
		}
	}
	writeMessage := func(role, kind, text string) {
		line, marshalErr := json.Marshal(map[string]any{"type": "response_item", "payload": map[string]any{
			"type": "message", "role": role, "content": []map[string]any{{"type": kind, "text": text}},
		}})
		if marshalErr != nil {
			b.Fatal(marshalErr)
		}
		if _, writeErr := file.Write(append(line, '\n')); writeErr != nil {
			b.Fatal(writeErr)
		}
	}
	writeMessage("user", "input_text", "latest question")
	writeMessage("assistant", "output_text", "latest answer")
	if err := file.Close(); err != nil {
		b.Fatal(err)
	}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}

	b.Run("cold_tail", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			page, stats, readErr := readTracePage(path, ref, 0, 200, parseCodexTrace)
			if readErr != nil || len(page.Items) != 2 || stats.ScannedBytes > traceInitialReadBytes {
				b.Fatalf("page=%+v stats=%+v err=%v", page, stats, readErr)
			}
		}
	})
	b.Run("unchanged_cache", func(b *testing.B) {
		reader := &Reader{CodexRoot: root}
		if _, err := reader.ReadTrace(ref, nil, 200); err != nil {
			b.Fatal(err)
		}
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := reader.ReadTrace(ref, nil, 200); err != nil {
				b.Fatal(err)
			}
		}
	})
}
