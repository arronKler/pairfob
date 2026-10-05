package journal

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestStoreSessionPagesBackwardsLikeALogFile(t *testing.T) {
	reader := hermesTestReader(t, func() []map[string]any {
		rows := make([]map[string]any, 0, 60)
		for turn := 0; turn < 30; turn++ {
			rows = append(rows,
				hermesRowFixture(2*turn+1, "user", map[string]any{"content": fmt.Sprintf("question %02d", turn)}),
				hermesRowFixture(2*turn+2, "assistant", map[string]any{"content": fmt.Sprintf("answer %02d", turn)}),
			)
		}
		return rows
	})
	var texts []string
	var cursor *string
	pages := 0
	for {
		page, err := reader.ReadTraceSummary(hermesTestRef(), cursor, 16)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		batch := make([]string, 0, len(page.Items))
		for _, item := range page.Items {
			batch = append(batch, item.Text)
		}
		texts = append(batch, texts...)
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}
	if pages < 4 || len(texts) != 60 || texts[0] != "question 00" || texts[59] != "answer 29" {
		t.Fatalf("pages=%d items=%d first=%q last=%q", pages, len(texts), texts[0], texts[len(texts)-1])
	}
	for index := 1; index < len(texts); index++ {
		if texts[index] == texts[index-1] {
			t.Fatalf("a record repeats across pages: %q", texts[index])
		}
	}
}

func TestStoreRenderingKeepsTheNewestRecordsWithinItsBound(t *testing.T) {
	big := strings.Repeat("x", maxStoreField+1000)
	records := make([]storeRecord, 0, 400)
	for index := 0; index < 400; index++ {
		records = append(records, storeRecord{Kind: storeTool, Name: "terminal", Call: fmt.Sprintf("c%d", index), Output: big, State: "done"})
	}
	data := renderStore(records)
	if len(data) > maxStoreBytes {
		t.Fatalf("rendered %d bytes, bound %d", len(data), maxStoreBytes)
	}
	lines := bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
	if len(lines) == 0 || len(lines) >= 400 {
		t.Fatalf("lines=%d", len(lines))
	}
	// Whole records go, oldest first; each kept line is cut, not broken.
	last := parseStoreTrace(lines[len(lines)-1])
	if len(last) != 1 || last[0].call != "c399" || len(last[0].Output) > maxStoreField+8 {
		t.Fatalf("last=%+v", last)
	}
	if first := parseStoreTrace(lines[0]); len(first) != 1 || first[0].call == "c0" {
		t.Fatalf("the oldest record was kept: %+v", first)
	}
}

func TestStoreLinesNeverYieldAnEventForUnknownOrEmptyRecords(t *testing.T) {
	for _, line := range []string{`{"k":"user"}`, `{"k":"assistant","text":""}`, `{"k":"tool","name":"bad name"}`, `{"k":"system","text":"x"}`, `not json`, `{}`} {
		if events := parseStoreTrace([]byte(line)); len(events) != 0 {
			t.Errorf("%s: %+v", line, events)
		}
		if message, ok := parseStore([]byte(line)); ok {
			t.Errorf("%s: %+v", line, message)
		}
	}
	// A result with no text still completes its tool.
	events := parseStoreTrace([]byte(`{"k":"result","call":"c1","state":"error"}`))
	if len(events) != 1 || !events[0].outputOnly || events[0].Output != "失败" || events[0].State != "error" {
		t.Fatalf("events=%+v", events)
	}
}
