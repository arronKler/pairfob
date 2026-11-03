package journal

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestTraceGrowthMatchesWholeWindowFold grows a tail window over a transcript
// larger than the initial read and compares it with the same read taken from a
// parser that re-parses the whole window every time. The incremental path is
// only an optimization; its page, cursor and truncation flags must not move.
func TestTraceGrowthMatchesWholeWindowFold(t *testing.T) {
	path := writeGrowthTranscript(t)
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: "session_growth_12345678"}
	cases := []struct {
		name    string
		limit   int
		options TraceOptions
	}{
		{"small page", 20, TraceOptions{}},
		{"full page", 200, TraceOptions{}},
		{"summary extras", 200, TraceOptions{Labels: true, Writes: true, Times: true}},
		{"markers", 40, TraceOptions{Markers: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := readTrace(openLogTranscript(t, path), ref, 0, tc.limit, parseClaudeTrace, tc.options)
			if err != nil {
				t.Fatal(err)
			}
			whole := tc.options
			whole.Models = true
			want, err := readTrace(openLogTranscript(t, path), ref, 0, tc.limit, parseClaudeTrace, whole)
			if err != nil {
				t.Fatal(err)
			}
			if got.scanned <= traceInitialReadBytes {
				t.Fatalf("scanned=%d, the fixture never grew the window", got.scanned)
			}
			if diff := traceReadDifference(got, want); diff != "" {
				t.Fatal(diff)
			}
		})
	}
}

func traceReadDifference(got, want traceRead) string {
	if got.start != want.start || got.tail != want.tail || got.scanned != want.scanned {
		return fmt.Sprintf("offsets: got start=%d tail=%d scanned=%d, want start=%d tail=%d scanned=%d",
			got.start, got.tail, got.scanned, want.start, want.tail, want.scanned)
	}
	if got.page.Truncated != want.page.Truncated || got.page.SummaryTruncated != want.page.SummaryTruncated {
		return fmt.Sprintf("truncation: got %v/%v, want %v/%v",
			got.page.Truncated, got.page.SummaryTruncated, want.page.Truncated, want.page.SummaryTruncated)
	}
	if (got.page.NextCursor == nil) != (want.page.NextCursor == nil) {
		return fmt.Sprintf("cursor: got %v, want %v", got.page.NextCursor, want.page.NextCursor)
	}
	if got.page.NextCursor != nil && *got.page.NextCursor != *want.page.NextCursor {
		return fmt.Sprintf("cursor: got %q, want %q", *got.page.NextCursor, *want.page.NextCursor)
	}
	if len(got.page.Items) != len(want.page.Items) {
		return fmt.Sprintf("items: got %d, want %d", len(got.page.Items), len(want.page.Items))
	}
	for i := range got.page.Items {
		if !reflect.DeepEqual(got.page.Items[i], want.page.Items[i]) {
			return fmt.Sprintf("item %d:\n got=%+v\nwant=%+v", i, got.page.Items[i], want.page.Items[i])
		}
	}
	return ""
}

// writeGrowthTranscript writes several MB of Claude records. Each turn keeps
// its chat events small and puts its bulk in records the chat never shows, so
// the tail window grows instead of filling the byte budget. The bulk sits
// between the prompt and the first answer, so the window's first parsed record
// is an assistant event, not a turn head.
func writeGrowthTranscript(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "growth.jsonl")
	var body strings.Builder
	bookkeeping := strings.Repeat("b", 40<<10)
	imagePayload := strings.Repeat("A", 60<<10)
	for turn := 0; turn < 40; turn++ {
		record := func(value any) {
			raw := jsonLine(t, value)
			body.Write(raw)
			body.WriteByte('\n')
		}
		call := fmt.Sprintf("call_%d", turn)
		record(map[string]any{"type": "user", "timestamp": "2026-11-03T10:00:00.000Z",
			"message": map[string]any{"role": "user", "content": fmt.Sprintf("question %d", turn)}})
		record(map[string]any{"type": "attachment", "payload": map[string]any{"padding": bookkeeping}})
		// A screenshot result with the block marker before its payload, as the
		// writer emits it, so the image prefilter can skip the record unread.
		body.WriteString(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` +
			call + `","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` +
			imagePayload + `"}}]}]}}`)
		body.WriteByte('\n')
		record(map[string]any{"type": "assistant", "timestamp": "2026-11-03T10:00:01.000Z",
			"message": map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": fmt.Sprintf("answer %d", turn)},
			}}})
		record(map[string]any{"type": "assistant", "timestamp": "2026-11-03T10:00:02.000Z",
			"message": map[string]any{"role": "assistant", "content": []any{map[string]any{
				"type": "tool_use", "id": call, "name": "Edit",
				"input": map[string]any{"file_path": fmt.Sprintf("/tmp/file_%d.go", turn)},
			}}}})
		record(map[string]any{"type": "user", "timestamp": "2026-11-03T10:00:03.000Z",
			"message": map[string]any{"role": "user", "content": []any{map[string]any{
				"type": "tool_result", "tool_use_id": call, "content": "ok",
			}}}})
	}
	if err := os.WriteFile(path, []byte(body.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPrependWindowMergesAcrossTheBoundary(t *testing.T) {
	tail := buildTraceWindow([]parsedEvent{
		{Event: Event{Type: "assistant", Text: "second"}, mergeKey: "message_1"},
	}, false, 10, TraceOptions{})
	got := prependTraceWindow([]parsedEvent{
		{Event: Event{Type: "assistant", Text: "first"}, mergeKey: "message_1"},
	}, false, tail, TraceOptions{})
	if len(got.items) != 1 || got.items[0].Text != "firstsecond" {
		t.Fatalf("merged items=%+v", got.items)
	}
}

func TestPrependWindowKeepsWritesDerivedBeforeInputWasClipped(t *testing.T) {
	input := jsonLine(t, map[string]any{
		"content":   strings.Repeat("x", maxMessageBytes+1024),
		"file_path": "/tmp/kept.go",
	})
	tail := buildTraceWindow([]parsedEvent{{
		Event: Event{Type: "tool", Name: "Edit", Input: string(input)},
	}}, false, 10, TraceOptions{Writes: true})
	if len(tail.items) != 1 || len(tail.items[0].Writes) != 1 || tail.items[0].Writes[0] != "/tmp/kept.go" {
		t.Fatalf("tail writes=%+v", tail.items)
	}
	if inputFields(tail.items[0].Input) != nil {
		t.Fatal("fixture input was not clipped, so the test proves nothing")
	}
	got := prependTraceWindow([]parsedEvent{
		{Event: Event{Type: "user", Text: "older"}, lineStart: 0},
	}, false, tail, TraceOptions{Writes: true})
	item := got.items[len(got.items)-1]
	if len(item.Writes) != 1 || item.Writes[0] != "/tmp/kept.go" {
		t.Fatalf("prepended writes=%+v, want the path derived before clipping", item.Writes)
	}
}

func TestPrependWindowKeepsTheDroppedBoundaryHead(t *testing.T) {
	tail := buildTraceWindow([]parsedEvent{
		{Event: Event{Type: "user", Text: "u1"}, lineStart: 0},
		{Event: Event{Type: "assistant", Text: "a1"}, lineStart: 1},
		{Event: Event{Type: "assistant", Text: "a2"}, lineStart: 2},
	}, false, 2, TraceOptions{})
	if tail.orphan == nil || tail.orphan.Text != "u1" || !tail.older {
		t.Fatalf("tail did not drop its turn head: %+v", tail)
	}
	got := prependTraceWindow([]parsedEvent{
		{Event: Event{Type: "user", Text: "u0"}, lineStart: -2},
		{Event: Event{Type: "assistant", Text: "a0"}, lineStart: -1},
	}, false, tail, TraceOptions{})
	if len(got.items) != 2 || got.items[0].Text != "a1" || got.items[1].Text != "a2" {
		t.Fatalf("prepended items=%+v", got.items)
	}
	if got.orphan == nil || got.orphan.Text != "u1" {
		t.Fatalf("boundary head=%+v, want the previously dropped u1", got.orphan)
	}
}
