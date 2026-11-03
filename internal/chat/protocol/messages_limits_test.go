package protocol

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// TestEntryValidateRejectsOversizedToolContent makes the per-entry budget part
// of the protocol contract: a tool entry the hub failed to clip can never be
// applied or sent.
func TestEntryValidateRejectsOversizedToolContent(t *testing.T) {
	entry := Entry{
		ID:   "call-1",
		Kind: KindTool,
		Tool: &Tool{Content: []ToolContent{{
			Type: "text",
			Text: strings.Repeat("x", MaxEntryWireBytes+1),
		}}},
	}
	if err := entry.Validate(); err == nil || !strings.Contains(err.Error(), "512 KiB") {
		t.Fatalf("Validate() = %v, want the entry size error", err)
	}
}

// TestServerMessageValidateRejectsOversizedFrames is the last line of defense:
// a snapshot or changes frame over one line is rejected before a writer can
// emit it, so a view never sees a frame it must drop.
func TestServerMessageValidateRejectsOversizedFrames(t *testing.T) {
	text := strings.Repeat("x", MaxEntryWireBytes/2)
	entries := make([]Entry, 0, 20)
	for i := 0; i < 20; i++ {
		entries = append(entries, Entry{ID: fmt.Sprintf("e%d", i), Kind: KindAgent, Text: text})
	}
	state := NewState("0123456789abcdef", "claude", "t")
	state.Entries = entries

	snapshot := ServerMessage{V: Version, Type: TypeSnapshot, Epoch: "9f2c", Seq: 1, State: state}
	if err := snapshot.Validate(); err == nil || !strings.Contains(err.Error(), "frame exceeds 4 MiB") {
		t.Fatalf("snapshot Validate() = %v, want the frame size error", err)
	}

	changes := ServerMessage{V: Version, Type: TypeChanges, Epoch: "9f2c", Seq: 20}
	for i := range entries {
		entry := entries[i]
		changes.Changes = append(changes.Changes, Change{
			Seq: int64(i + 1),
			Ops: []Op{{Op: OpAppendEntry, Entry: &entry}},
		})
	}
	if err := changes.Validate(); err == nil || !strings.Contains(err.Error(), "frame exceeds 4 MiB") {
		t.Fatalf("changes Validate() = %v, want the frame size error", err)
	}
}

func TestClipTextKeepsMarkerInsideLimit(t *testing.T) {
	text := strings.Repeat("é", 100)
	clipped := ClipText(text, 50)
	if len(clipped) > 50 {
		t.Fatalf("clipped length = %d, want <= 50", len(clipped))
	}
	if !strings.HasSuffix(clipped, TruncatedMarker) {
		t.Fatalf("clipped = %q, want the truncation marker", clipped)
	}
	if strings.ContainsRune(clipped[:len(clipped)-len(TruncatedMarker)], '�') {
		t.Fatal("clipping split a multi-byte rune")
	}
	if got := ClipText("short", 50); got != "short" {
		t.Fatalf("short text = %q", got)
	}
}

func TestStateWireBytesMatchesEncoding(t *testing.T) {
	state := NewState("0123456789abcdef", "claude", "t")
	state.Entries = []Entry{
		{ID: "a", Kind: KindAgent, Text: "hello"},
		{ID: "b", Kind: KindTool, Tool: &Tool{Title: "Read", Content: []ToolContent{{Type: "text", Text: "x"}}}},
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	if got, want := StateWireBytes(state), len(data); got != want {
		t.Fatalf("StateWireBytes = %d, encoded = %d", got, want)
	}
}
