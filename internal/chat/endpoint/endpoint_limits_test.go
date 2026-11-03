package endpoint

import (
	"strings"
	"testing"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

// TestOversizedToolCallStillYieldsBoundedFrames runs the defect end to end: a
// 5 MiB tool payload enters the hub, the live view receives a clipped change,
// and a reconnecting view receives a snapshot both sides can actually read.
func TestOversizedToolCallStillYieldsBoundedFrames(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	rig.agent.events <- acp.Event{Kind: acp.EventUpdate, Update: &acp.Update{
		Kind: acp.UpdateToolCall,
		ToolCall: &acp.ToolCall{
			ToolCallID: "call-big",
			Title:      "Build",
			Kind:       "execute",
			Status:     "completed",
			Content:    []acp.ToolContent{{Type: "text", Text: strings.Repeat("x", 5<<20)}},
		},
	}}

	frame := v.read()
	if frame.Type != protocol.TypeChanges || len(frame.Changes) != 1 {
		t.Fatalf("frame = %+v, want one change", frame)
	}
	ops := frame.Changes[0].Ops
	if len(ops) == 0 || ops[0].Entry == nil || ops[0].Entry.Tool == nil {
		t.Fatalf("change ops = %+v", ops)
	}
	entry := ops[0].Entry
	last := entry.Tool.Content[len(entry.Tool.Content)-1].Text
	if !strings.Contains(last, protocol.TruncatedMarker) {
		t.Fatalf("last tool block = %q, want the truncation marker", last)
	}

	// A new view walks the same handshake with no cursor. The snapshot must
	// stay inside one line and still carry the clipped entry.
	other := dialView(t, rig.path)
	_, snapshot := other.greet(nil)
	if snapshot.Type != protocol.TypeSnapshot || snapshot.State == nil {
		t.Fatalf("second frame = %+v, want a snapshot", snapshot)
	}
	found := false
	for _, candidate := range snapshot.State.Entries {
		if candidate.ID == "call-big" {
			found = true
		}
	}
	if !found {
		t.Fatal("snapshot is missing the clipped tool entry")
	}
}
