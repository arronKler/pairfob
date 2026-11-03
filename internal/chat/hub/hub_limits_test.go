package hub

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

// drainChanges returns every change a subscription has queued.
func drainChanges(sub *Subscription) []protocol.Change {
	var changes []protocol.Change
	for {
		select {
		case change, ok := <-sub.C:
			if !ok {
				return changes
			}
			changes = append(changes, change)
		default:
			return changes
		}
	}
}

// assertChangeFramesFit fails when one change cannot travel in one line.
func assertChangeFramesFit(t *testing.T, epoch string, changes []protocol.Change) {
	t.Helper()
	for _, change := range changes {
		frame := protocol.ServerMessage{
			V:       protocol.Version,
			Type:    protocol.TypeChanges,
			Epoch:   epoch,
			Seq:     change.Seq,
			Changes: []protocol.Change{change},
		}
		data, err := json.Marshal(frame)
		if err != nil {
			t.Fatalf("encode change %d: %v", change.Seq, err)
		}
		if len(data)+1 > protocol.MaxLineBytes {
			t.Fatalf("change %d frame = %d bytes, want <= %d", change.Seq, len(data)+1, protocol.MaxLineBytes)
		}
	}
}

func assertSnapshotFits(t *testing.T, state *protocol.State) {
	t.Helper()
	frame := protocol.ServerMessage{
		V:     protocol.Version,
		Type:  protocol.TypeSnapshot,
		Epoch: "01234567",
		Seq:   1,
		State: state,
	}
	data, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("encode snapshot: %v", err)
	}
	if len(data)+1 > protocol.MaxLineBytes {
		t.Fatalf("snapshot frame = %d bytes, want <= %d", len(data)+1, protocol.MaxLineBytes)
	}
	if err := frame.Validate(); err != nil {
		t.Fatalf("snapshot frame does not validate: %v", err)
	}
}

// TestOversizedToolContentIsClippedNotDropped covers the defect: a 5 MiB tool
// payload must be recorded (not silently rejected by the ignored apply error),
// clipped with a visible marker, and still fit one snapshot and one change.
func TestOversizedToolContentIsClippedNotDropped(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("build", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	attachment, sub := h.Attach(nil, 64)
	defer sub.Close()

	huge := strings.Repeat("x", 5<<20)
	agent.emitUpdate(acp.Update{Kind: acp.UpdateToolCall, ToolCall: &acp.ToolCall{
		ToolCallID: "call-big",
		Title:      "Build the project",
		Kind:       "execute",
		Status:     "pending",
		Content:    []acp.ToolContent{{Type: "text", Text: huge}},
	}})
	waitFor(t, "tool entry", func() bool { return entryByID(h.Snapshot(), "call-big") != nil })

	// A later update replaces the content again. It must be applied, not
	// silently dropped by the event loop's ignored apply error.
	agent.emitUpdate(acp.Update{Kind: acp.UpdateToolCallUpdate, ToolCall: &acp.ToolCall{
		ToolCallID: "call-big",
		Status:     "completed",
		Content:    []acp.ToolContent{{Type: "text", Text: huge}},
	}})
	waitFor(t, "tool status update", func() bool {
		entry := entryByID(h.Snapshot(), "call-big")
		return entry != nil && entry.Tool != nil && entry.Tool.Status == "completed"
	})

	state := h.Snapshot()
	entry := entryByID(state, "call-big")
	if entry == nil {
		t.Fatal("the tool entry disappeared")
	}
	if len(entry.Tool.Content) == 0 {
		t.Fatalf("tool content = %+v", entry.Tool.Content)
	}
	if !strings.Contains(entry.Tool.Content[len(entry.Tool.Content)-1].Text, protocol.TruncatedMarker) {
		t.Fatalf("last tool block = %q, want the truncation marker", entry.Tool.Content[len(entry.Tool.Content)-1].Text)
	}
	if size := protocol.EntryWireBytes(*entry); size > protocol.MaxEntryWireBytes {
		t.Fatalf("entry wire size = %d, want <= %d", size, protocol.MaxEntryWireBytes)
	}
	assertSnapshotFits(t, state)
	assertChangeFramesFit(t, attachment.Epoch, drainChanges(sub))

	// Repeated reconnects without a cursor keep getting the same bounded
	// snapshot rather than an oversized frame the view has to drop.
	for i := 0; i < 3; i++ {
		reattached, sub := h.Attach(nil, 4)
		sub.Close()
		if reattached.State == nil {
			t.Fatalf("attach %d did not return a snapshot", i)
		}
		assertSnapshotFits(t, reattached.State)
	}

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}

// TestStreamingTextIsTruncatedAtEntryBudget grows one agent message far past
// the entry budget and checks that the tail is clipped with the marker and
// that each streamed change still fits one line.
func TestStreamingTextIsTruncatedAtEntryBudget(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("log", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	attachment, sub := h.Attach(nil, 256)
	defer sub.Close()

	chunk := strings.Repeat("y", 64<<10)
	for i := 0; i < 100; i++ {
		agent.emitUpdate(acp.Update{
			Kind:      acp.UpdateAgentMessageChunk,
			MessageID: "msg-big",
			Content:   acp.TextBlock(chunk),
		})
	}
	waitFor(t, "clipped stream", func() bool {
		entry := entryByID(h.Snapshot(), "msg-big")
		return entry != nil && strings.HasSuffix(entry.Text, protocol.TruncatedMarker)
	})

	state := h.Snapshot()
	entry := entryByID(state, "msg-big")
	if size := protocol.EntryWireBytes(*entry); size > protocol.MaxEntryWireBytes {
		t.Fatalf("entry wire size = %d, want <= %d", size, protocol.MaxEntryWireBytes)
	}
	if len(entry.Text) >= 6<<20 {
		t.Fatalf("stream kept %d bytes, want the budget to clip it", len(entry.Text))
	}
	assertSnapshotFits(t, state)
	assertChangeFramesFit(t, attachment.Epoch, drainChanges(sub))

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}

// TestTranscriptEvictsOldestEntriesToFitSnapshot fills the transcript past the
// snapshot budget and checks that the oldest entries are dropped, the newest
// are retained, and a reconnect gets a bounded frame.
func TestTranscriptEvictsOldestEntriesToFitSnapshot(t *testing.T) {
	h, _ := startHub(t)

	text := strings.Repeat("z", 400<<10)
	h.mu.Lock()
	for i := 0; i < 12; i++ {
		entry := protocol.Entry{
			ID:   fmt.Sprintf("bulk-%d", i),
			Kind: protocol.KindNotice,
			Text: text,
			At:   int64(i),
		}
		if err := h.applyLocked([]protocol.Op{{Op: protocol.OpAppendEntry, Entry: &entry}}); err != nil {
			h.mu.Unlock()
			t.Fatalf("append bulk-%d: %v", i, err)
		}
	}
	stateWire := h.stateWireLocked()
	h.mu.Unlock()

	if stateWire > protocol.MaxSnapshotStateBytes {
		t.Fatalf("retained state = %d bytes, want <= %d", stateWire, protocol.MaxSnapshotStateBytes)
	}
	state := h.Snapshot()
	if entryByID(state, "bulk-0") != nil {
		t.Fatal("oldest entry survived eviction")
	}
	if entryByID(state, "bulk-11") == nil {
		t.Fatal("newest entry was evicted")
	}
	if entryByID(state, limitNoticeID) == nil {
		t.Fatal("eviction did not leave a visible notice")
	}
	assertSnapshotFits(t, state)

	// A reconnect with no cursor gets the bounded snapshot.
	attachment, sub := h.Attach(nil, 4)
	sub.Close()
	if attachment.State == nil {
		t.Fatal("no-cursor attach did not return a snapshot")
	}
	assertSnapshotFits(t, attachment.State)

	// A cursor from before the eviction cannot replay everything in one line,
	// so the hub must fall back to the snapshot instead of sending it.
	head := h.Cursor()
	stale, sub := h.Attach(&protocol.Cursor{Epoch: head.Epoch, Seq: 0}, 4)
	sub.Close()
	if stale.State == nil {
		if len(stale.Changes) > 0 {
			assertChangeFramesFit(t, stale.Epoch, stale.Changes)
		}
		t.Fatal("stale cursor replay exceeded one line without a snapshot fallback")
	}
	assertSnapshotFits(t, stale.State)

	// A recent cursor still replays a bounded change.
	recent, sub := h.Attach(&protocol.Cursor{Epoch: head.Epoch, Seq: head.Seq - 1}, 4)
	sub.Close()
	if recent.State != nil || len(recent.Changes) != 1 {
		t.Fatalf("recent cursor attachment = %+v", recent)
	}
	assertChangeFramesFit(t, recent.Epoch, recent.Changes)
}

// TestUnclippableUpdateLeavesVisibleNotice covers the apply-error path: an
// entry whose identity alone cannot fit the entry budget is rejected, but the
// rejection leaves a notice so an ignored error is not silent.
func TestUnclippableUpdateLeavesVisibleNotice(t *testing.T) {
	h, _ := startHub(t)
	entry := protocol.Entry{
		ID:   strings.Repeat("i", protocol.MaxEntryWireBytes+1),
		Kind: protocol.KindNotice,
	}

	h.mu.Lock()
	err := h.applyLocked([]protocol.Op{{Op: protocol.OpAppendEntry, Entry: &entry}})
	h.mu.Unlock()
	if err == nil {
		t.Fatal("unclippable entry was accepted")
	}
	if entryByID(h.Snapshot(), "notice-update-dropped") == nil {
		t.Fatal("dropped update left no visible notice")
	}
}

// TestStateWireAccountingMatchesEncoding guards the incremental accounting the
// snapshot budget depends on.
func TestStateWireAccountingMatchesEncoding(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("hello", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })
	agent.emitUpdate(acp.Update{Kind: acp.UpdateToolCall, ToolCall: &acp.ToolCall{
		ToolCallID: "call-1",
		Title:      "Read",
		Kind:       "read",
		Status:     "pending",
		Content:    []acp.ToolContent{{Type: "text", Text: "reading"}},
	}})
	agent.emitUpdate(acp.Update{Kind: acp.UpdatePlan, Plan: []acp.PlanEntry{
		{Content: "Read", Priority: "high", Status: "completed"},
	}})
	waitFor(t, "tool and plan", func() bool {
		state := h.Snapshot()
		return entryByID(state, "call-1") != nil && len(state.Plan) == 1
	})

	h.mu.Lock()
	accounted := h.stateWireLocked()
	data, err := json.Marshal(h.state)
	h.mu.Unlock()
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	encoded := len(data)
	if accounted != encoded {
		t.Fatalf("accounted state = %d bytes, encoded = %d", accounted, encoded)
	}

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}
