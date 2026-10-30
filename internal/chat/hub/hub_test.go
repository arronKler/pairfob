package hub

import (
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

func TestReadyPublishesModesAndOptions(t *testing.T) {
	h, _ := startHub(t)
	state := h.Snapshot()
	if state.Status != protocol.StatusIdle {
		t.Fatalf("status = %q, want idle", state.Status)
	}
	if state.Mode != "default" || len(state.Modes) != 2 {
		t.Fatalf("modes = %+v mode %q", state.Modes, state.Mode)
	}
	if len(state.Options) != 1 || state.Options[0].CurrentValue != "sonnet" {
		t.Fatalf("options = %+v", state.Options)
	}
	if len(state.Options[0].Choices) != 2 {
		t.Fatalf("choices = %+v", state.Options[0].Choices)
	}
}

func TestAgentChunksAccumulate(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("hello", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	agent.emitUpdate(acp.Update{Kind: acp.UpdateAgentMessageChunk, MessageID: "msg-1", Content: acp.TextBlock("Hel")})
	agent.emitUpdate(acp.Update{Kind: acp.UpdateAgentMessageChunk, MessageID: "msg-1", Content: acp.TextBlock("lo")})
	agent.emitUpdate(acp.Update{Kind: acp.UpdateAgentMessageChunk, Content: acp.TextBlock("anon-1")})
	agent.emitUpdate(acp.Update{Kind: acp.UpdateAgentMessageChunk, Content: acp.TextBlock("anon-2")})
	agent.emitUpdate(acp.Update{Kind: acp.UpdateAgentThoughtChunk, Content: acp.TextBlock("thinking")})

	waitFor(t, "streamed entries", func() bool {
		state := h.Snapshot()
		message := entryByID(state, "msg-1")
		anonymous := entryByID(state, "turn-1-agent")
		thought := entryByID(state, "turn-1-thought")
		return message != nil && message.Text == "Hello" && message.Streaming &&
			anonymous != nil && anonymous.Text == "anon-1anon-2" &&
			thought != nil && thought.Text == "thinking"
	})

	agent.complete(0, acp.PromptResult{StopReason: "end_turn"}, nil)
	waitStatus(t, h, protocol.StatusIdle)

	state := h.Snapshot()
	for _, id := range []string{"msg-1", "turn-1-agent", "turn-1-thought"} {
		entry := entryByID(state, id)
		if entry == nil {
			t.Fatalf("entry %q missing", id)
		}
		if entry.Streaming {
			t.Fatalf("entry %q is still streaming after the turn closed", id)
		}
	}
	if state.Error != "" {
		t.Fatalf("error = %q", state.Error)
	}
	if user := entryByID(state, "user-1"); user == nil || user.Text != "hello" {
		t.Fatalf("user entry = %+v", user)
	}
}

func TestToolCallsMergeByID(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("edit", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	agent.emitUpdate(acp.Update{Kind: acp.UpdateToolCall, ToolCall: &acp.ToolCall{
		ToolCallID: "call-1",
		Title:      "Read a file",
		Kind:       "read",
		Status:     "pending",
		Content: []acp.ToolContent{
			{Type: "text", Text: "reading"},
			{Type: "diff", Diff: &acp.ToolDiff{Path: "/work/a.txt", OldText: "old", NewText: "new"}},
		},
		Locations: []acp.ToolLocation{{Path: "/work/a.txt"}},
	}})
	waitFor(t, "tool entry", func() bool { return entryByID(h.Snapshot(), "call-1") != nil })

	agent.emitUpdate(acp.Update{Kind: acp.UpdateToolCallUpdate, ToolCall: &acp.ToolCall{
		ToolCallID: "call-1",
		Status:     "completed",
		Content:    []acp.ToolContent{{Type: "text", Text: "done"}},
	}})
	waitFor(t, "tool status", func() bool {
		entry := entryByID(h.Snapshot(), "call-1")
		return entry != nil && entry.Tool != nil && entry.Tool.Status == "completed"
	})

	state := h.Snapshot()
	if count := len(state.Entries); count != 2 {
		t.Fatalf("entries = %d, want the user turn and one tool", count)
	}
	tool := entryByID(state, "call-1").Tool
	if tool.Title != "Read a file" || tool.Kind != "read" {
		t.Fatalf("update dropped unchanged fields: %+v", tool)
	}
	if len(tool.Content) != 1 || tool.Content[0].Text != "done" {
		t.Fatalf("content = %+v", tool.Content)
	}
	if len(tool.Locations) != 1 || tool.Locations[0] != "/work/a.txt" {
		t.Fatalf("locations = %+v", tool.Locations)
	}

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}

func TestPlanAndUsage(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("plan", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	agent.emitUpdate(acp.Update{Kind: acp.UpdatePlan, Plan: []acp.PlanEntry{
		{Content: "Read", Priority: "high", Status: "completed"},
		{Content: "Edit", Priority: "urgent", Status: "done"},
		{Content: "", Priority: "low", Status: "pending"},
	}})
	agent.emitUpdate(acp.Update{Kind: acp.UpdateUsage, Usage: &acp.UsageUpdate{
		Used: 31994, Size: 1000000, Cost: &acp.Cost{Amount: 0.16, Currency: "USD"},
	}})

	waitFor(t, "plan and usage", func() bool {
		state := h.Snapshot()
		return len(state.Plan) == 2 && state.Usage != nil && state.Usage.CostUSD == 0.16
	})
	state := h.Snapshot()
	if state.Plan[1].Priority != "" || state.Plan[1].Status != "" {
		t.Fatalf("unknown plan enums leaked through: %+v", state.Plan[1])
	}
	if state.Usage.Used != 31994 || state.Usage.Size != 1000000 {
		t.Fatalf("usage = %+v", state.Usage)
	}

	agent.emitUpdate(acp.Update{Kind: acp.UpdateUsage, Usage: &acp.UsageUpdate{Used: 10, Size: 20}})
	waitFor(t, "usage without cost", func() bool {
		usage := h.Snapshot().Usage
		return usage != nil && usage.Used == 10 && usage.CostUSD == 0.16
	})

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}

func TestModeAndOptionUpdates(t *testing.T) {
	h, agent := startHub(t)

	if err := h.SetMode("plan"); err != nil {
		t.Fatalf("set mode: %v", err)
	}
	waitFor(t, "mode update", func() bool { return h.Snapshot().Mode == "plan" })
	if modes := agent.modesSet(); len(modes) != 1 || modes[0] != "plan" {
		t.Fatalf("agent modes = %+v", modes)
	}
	if code := errorCode(h.SetMode("nope")); code != protocol.ErrCodeNotFound {
		t.Fatalf("unknown mode code = %q", code)
	}

	if err := h.SetOption("model", "haiku"); err != nil {
		t.Fatalf("set option: %v", err)
	}
	waitFor(t, "option update", func() bool {
		options := h.Snapshot().Options
		return len(options) == 1 && options[0].CurrentValue == "haiku"
	})
	if code := errorCode(h.SetOption("model", "opus")); code != protocol.ErrCodeInvalid {
		t.Fatalf("unknown value code = %q", code)
	}
	if code := errorCode(h.SetOption("effort", "high")); code != protocol.ErrCodeNotFound {
		t.Fatalf("unknown option code = %q", code)
	}
	if configs := agent.configsSet(); len(configs) != 1 || configs[0] != (fakeConfig{"model", "haiku"}) {
		t.Fatalf("agent configs = %+v", configs)
	}

	agent.emitUpdate(acp.Update{Kind: acp.UpdateConfigOption, ConfigOptions: []acp.ConfigOption{{
		ID: "effort", Name: "Effort", Type: "select", CurrentValue: "high",
		Options: []acp.ConfigOptionValue{{Value: "high", Name: "High"}},
	}}})
	waitFor(t, "merged options", func() bool { return len(h.Snapshot().Options) == 2 })
	options := h.Snapshot().Options
	if options[0].ID != "model" || options[1].ID != "effort" {
		t.Fatalf("merge order = %+v", options)
	}
}

func TestExitRecordsCauseAndKeepsTranscript(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("hello", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })
	agent.emitUpdate(acp.Update{Kind: acp.UpdateAgentMessageChunk, MessageID: "msg-1", Content: acp.TextBlock("partial")})
	waitFor(t, "streaming entry", func() bool { return entryByID(h.Snapshot(), "msg-1") != nil })

	agent.emit(acp.Event{Kind: acp.EventExit, Exit: &acp.Exit{
		Err: errors.New("exec: adapter died"), Code: 3, Stderr: "stack trace\n",
	}})
	waitStatus(t, h, protocol.StatusExited)

	state := h.Snapshot()
	if !strings.Contains(state.Error, "adapter died") || !strings.Contains(state.Error, "stack trace") {
		t.Fatalf("error = %q", state.Error)
	}
	entry := entryByID(state, "msg-1")
	if entry == nil || entry.Streaming {
		t.Fatalf("streaming flag survived the exit: %+v", entry)
	}
	if code := errorCode(h.Prompt("later", nil)); code != protocol.ErrCodeAgent {
		t.Fatalf("prompt after exit code = %q", code)
	}
}

func TestCleanExitHasNoError(t *testing.T) {
	h, agent := startHub(t)
	agent.emit(acp.Event{Kind: acp.EventExit, Exit: &acp.Exit{Err: io.EOF}})
	waitStatus(t, h, protocol.StatusExited)
	if state := h.Snapshot(); state.Error != "" {
		t.Fatalf("clean exit error = %q", state.Error)
	}
}

func TestExitClearsPendingPermissionAndQueue(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("hello", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })
	if err := h.Prompt("queued", nil); err != nil {
		t.Fatalf("queue prompt: %v", err)
	}
	agent.emitPermission("0", acp.PermissionOption{OptionID: "allow", Name: "Allow", Kind: "allow_once"})
	waitFor(t, "permission", func() bool { return h.Snapshot().Permission != nil })

	agent.emit(acp.Event{Kind: acp.EventExit, Exit: &acp.Exit{Err: io.EOF}})
	waitStatus(t, h, protocol.StatusExited)
	state := h.Snapshot()
	if state.Permission != nil {
		t.Fatalf("permission survived exit: %+v", state.Permission)
	}
	if len(state.Queue) != 0 {
		t.Fatalf("queue survived exit: %+v", state.Queue)
	}
}

func TestAttachReplayAndSnapshotFallback(t *testing.T) {
	h := New(Config{ID: "0123456789abcdef", Agent: "claude", Title: "t", HistoryChanges: 2})
	agent := newFakeAgent()
	h.SetAgent(agent)
	if err := h.Ready(testSession()); err != nil {
		t.Fatalf("ready: %v", err)
	}
	go h.Run()
	t.Cleanup(agent.closeEvents)

	if err := h.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	if err := h.SetAutoAccept(false); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	head := h.Cursor()

	attachment, sub := h.Attach(&protocol.Cursor{Epoch: head.Epoch, Seq: head.Seq - 1}, 4)
	sub.Close()
	if attachment.State != nil {
		t.Fatal("cursor replay returned a snapshot")
	}
	if len(attachment.Changes) != 1 || attachment.Changes[0].Seq != head.Seq {
		t.Fatalf("changes = %+v", attachment.Changes)
	}

	for _, cursor := range []*protocol.Cursor{
		nil,
		{Epoch: head.Epoch, Seq: 0},
		{Epoch: head.Epoch, Seq: head.Seq},
		{Epoch: "deadbeef", Seq: head.Seq - 1},
		{Epoch: head.Epoch, Seq: head.Seq + 1},
	} {
		attachment, sub := h.Attach(cursor, 4)
		sub.Close()
		if attachment.State == nil {
			t.Fatalf("cursor %+v did not fall back to a snapshot", cursor)
		}
	}
}

func TestSlowSubscriptionIsClosed(t *testing.T) {
	h, _ := startHub(t)
	attachment, sub := h.Attach(nil, 1)
	if attachment.State == nil {
		t.Fatal("expected a snapshot")
	}
	if err := h.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	if err := h.SetAutoAccept(false); err != nil {
		t.Fatalf("auto accept: %v", err)
	}

	select {
	case _, ok := <-sub.C:
		if !ok {
			t.Fatal("subscription closed before delivering the first change")
		}
	case <-time.After(time.Second):
		t.Fatal("no change delivered")
	}
	waitFor(t, "closed subscription", func() bool {
		_, ok := <-sub.C
		return !ok
	})
	sub.Close()
}

func TestAtomicOpFailureLeavesStateAndSeq(t *testing.T) {
	h, _ := startHub(t)
	before := h.Cursor()
	entries := len(h.Snapshot().Entries)
	attachment, sub := h.Attach(nil, 8)
	_ = attachment
	defer sub.Close()

	h.mu.Lock()
	err := h.applyLocked([]protocol.Op{{Op: protocol.OpAppendText, ID: "missing", Text: "x"}})
	h.mu.Unlock()
	if err == nil {
		t.Fatal("apply of a missing entry succeeded")
	}
	after := h.Cursor()
	if after.Seq != before.Seq {
		t.Fatalf("seq moved from %d to %d", before.Seq, after.Seq)
	}
	if got := len(h.Snapshot().Entries); got != entries {
		t.Fatalf("entries changed from %d to %d", entries, got)
	}
	select {
	case change := <-sub.C:
		t.Fatalf("failed apply fanned out %+v", change)
	default:
	}
}

func TestPromptBeforeReadyIsBusy(t *testing.T) {
	h := New(Config{ID: "0123456789abcdef", Agent: "claude", Title: "t"})
	h.SetAgent(newFakeAgent())
	if code := errorCode(h.Prompt("hello", nil)); code != protocol.ErrCodeBusy {
		t.Fatalf("code = %q, want busy", code)
	}
}

func TestExitRefinesStartupError(t *testing.T) {
	h := New(Config{ID: "0123456789abcdef", Agent: "claude", Title: "t"})
	agent := newFakeAgent()
	h.SetAgent(agent)
	go h.Run()
	t.Cleanup(agent.closeEvents)

	h.Fail(errors.New("initialize: EOF"))
	waitStatus(t, h, protocol.StatusExited)
	if message := h.Snapshot().Error; message != "initialize: EOF" {
		t.Fatalf("startup error = %q", message)
	}

	agent.emit(acp.Event{Kind: acp.EventExit, Exit: &acp.Exit{
		Err: errors.New("exit status 3"), Code: 3, Stderr: "adapter exploded\n",
	}})
	waitFor(t, "refined error", func() bool {
		return strings.Contains(h.Snapshot().Error, "exit status 3")
	})
	if message := h.Snapshot().Error; !strings.Contains(message, "adapter exploded") {
		t.Fatalf("refined error = %q", message)
	}

	before := h.Snapshot().Error
	agent.emit(acp.Event{Kind: acp.EventExit, Exit: &acp.Exit{Err: io.EOF}})
	time.Sleep(20 * time.Millisecond)
	if after := h.Snapshot().Error; after != before {
		t.Fatalf("clean exit overwrote the cause: %q", after)
	}
}

func errorCode(err error) string {
	var commandErr *CommandError
	if errors.As(err, &commandErr) {
		return commandErr.Code
	}
	return ""
}
