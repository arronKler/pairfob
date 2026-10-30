package hub

import (
	"encoding/base64"
	"errors"
	"testing"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

func TestQueueDrainsOnTurnClose(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("one", nil); err != nil {
		t.Fatalf("prompt one: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	if err := h.Prompt("two", nil); err != nil {
		t.Fatalf("queue two: %v", err)
	}
	if err := h.Prompt("three", nil); err != nil {
		t.Fatalf("queue three: %v", err)
	}
	queue := h.Snapshot().Queue
	if len(queue) != 2 || queue[0].ID != "q1" || queue[0].Text != "two" || queue[1].ID != "q2" {
		t.Fatalf("queue = %+v", queue)
	}

	agent.complete(0, acp.PromptResult{StopReason: "end_turn"}, nil)
	waitFor(t, "second prompt", func() bool { return agent.promptCount() == 2 })
	waitFor(t, "drained queue", func() bool {
		state := h.Snapshot()
		return state.Status == protocol.StatusWorking && len(state.Queue) == 1 && state.Queue[0].ID == "q2"
	})
	if text := agent.textOfPrompt(t, 1); text != "two" {
		t.Fatalf("second prompt text = %q", text)
	}

	agent.complete(1, acp.PromptResult{}, nil)
	waitFor(t, "third prompt", func() bool { return agent.promptCount() == 3 })
	if text := agent.textOfPrompt(t, 2); text != "three" {
		t.Fatalf("third prompt text = %q", text)
	}
	agent.complete(2, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)

	state := h.Snapshot()
	if len(state.Queue) != 0 {
		t.Fatalf("queue after drain = %+v", state.Queue)
	}
	if len(state.Entries) != 3 {
		t.Fatalf("entries = %d, want three user turns", len(state.Entries))
	}
}

func TestUnqueue(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("one", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })
	if err := h.Prompt("two", nil); err != nil {
		t.Fatalf("queue two: %v", err)
	}
	if err := h.Prompt("three", nil); err != nil {
		t.Fatalf("queue three: %v", err)
	}

	if code := errorCode(h.Unqueue("q9")); code != protocol.ErrCodeNotFound {
		t.Fatalf("unknown queue id code = %q", code)
	}
	if err := h.Unqueue("q1"); err != nil {
		t.Fatalf("unqueue q1: %v", err)
	}
	queue := h.Snapshot().Queue
	if len(queue) != 1 || queue[0].ID != "q2" {
		t.Fatalf("queue = %+v", queue)
	}

	agent.complete(0, acp.PromptResult{}, nil)
	waitFor(t, "second prompt", func() bool { return agent.promptCount() == 2 })
	agent.complete(1, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
	if err := h.Unqueue("q2"); err != nil {
		t.Fatalf("unqueue on an idle queue: %v", err)
	}
}

func TestCancelSendsSessionCancelAndWaitsForTheTurn(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("slow", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	if err := h.Cancel(); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	cancels := agent.cancelsSeen()
	if len(cancels) != 1 || cancels[0] != "sess-1" {
		t.Fatalf("cancels = %+v", cancels)
	}
	if status := h.Snapshot().Status; status != protocol.StatusWorking {
		t.Fatalf("status after cancel = %q, want working until the turn returns", status)
	}

	agent.complete(0, acp.PromptResult{StopReason: "cancelled"}, nil)
	waitStatus(t, h, protocol.StatusIdle)
	if err := h.Cancel(); err != nil {
		t.Fatalf("idle cancel: %v", err)
	}
	if got := len(agent.cancelsSeen()); got != 1 {
		t.Fatalf("idle cancel sent %d notifications", got)
	}
}

func TestPermissionManualAnswer(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("run", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	agent.emitPermission("0",
		acp.PermissionOption{OptionID: "allow", Name: "Allow", Kind: "allow_once"},
		acp.PermissionOption{OptionID: "reject", Name: "Reject", Kind: "reject_once"},
	)
	waitFor(t, "permission", func() bool { return h.Snapshot().Permission != nil })
	state := h.Snapshot()
	if state.Status != protocol.StatusBlocked {
		t.Fatalf("status = %q, want blocked", state.Status)
	}
	if state.Permission.Title != "Read a file" || state.Permission.ToolCallID != "call-1" {
		t.Fatalf("permission = %+v", state.Permission)
	}
	if len(state.Permission.Options) != 2 {
		t.Fatalf("options = %+v", state.Permission.Options)
	}

	if code := errorCode(h.Answer("other", "allow")); code != protocol.ErrCodePermissionGone {
		t.Fatalf("wrong request code = %q", code)
	}
	if code := errorCode(h.Answer("0", "maybe")); code != protocol.ErrCodeInvalid {
		t.Fatalf("unknown option code = %q", code)
	}
	if err := h.Answer("0", "reject"); err != nil {
		t.Fatalf("answer: %v", err)
	}
	answers := agent.answersSeen()
	if len(answers) != 1 || answers[0] != (fakeAnswer{"0", "reject"}) {
		t.Fatalf("answers = %+v", answers)
	}
	waitFor(t, "permission cleared", func() bool { return h.Snapshot().Permission == nil })
	if status := h.Snapshot().Status; status != protocol.StatusWorking {
		t.Fatalf("status after answer = %q, want working", status)
	}
	if code := errorCode(h.Answer("0", "allow")); code != protocol.ErrCodePermissionGone {
		t.Fatalf("re-answer code = %q", code)
	}

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}

func TestPermissionAutoAccept(t *testing.T) {
	h, agent := startHub(t)
	if err := h.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	if err := h.Prompt("run", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })

	agent.emitPermission("7",
		acp.PermissionOption{OptionID: "reject", Name: "Reject", Kind: "reject_once"},
		acp.PermissionOption{OptionID: "always", Name: "Always", Kind: "allow_always"},
	)
	waitFor(t, "auto answer", func() bool { return len(agent.answersSeen()) == 1 })
	answers := agent.answersSeen()
	if answers[0] != (fakeAnswer{"7", "always"}) {
		t.Fatalf("auto answer = %+v", answers[0])
	}
	waitFor(t, "permission cleared", func() bool { return h.Snapshot().Permission == nil })
	if status := h.Snapshot().Status; status != protocol.StatusWorking {
		t.Fatalf("status = %q", status)
	}
	if !h.Snapshot().AutoAccept {
		t.Fatal("auto_accept flag not published")
	}

	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}

func TestEnablingAutoAcceptAnswersPendingPermission(t *testing.T) {
	h, agent := startHub(t)
	if err := h.Prompt("run", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })
	agent.emitPermission("3", acp.PermissionOption{OptionID: "allow", Name: "Allow", Kind: "allow_once"})
	waitFor(t, "permission", func() bool { return h.Snapshot().Permission != nil })

	if err := h.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	waitFor(t, "auto answer", func() bool { return len(agent.answersSeen()) == 1 })
	waitFor(t, "permission cleared", func() bool { return h.Snapshot().Permission == nil })
}

func TestPromptWithAttachments(t *testing.T) {
	h, agent := startHub(t)
	image := base64.StdEncoding.EncodeToString([]byte("png-bytes"))
	err := h.Prompt("look", []protocol.Attachment{
		{Name: "shot.png", Mime: "image/png", Data: image},
		{Name: "notes.txt", Mime: "text/plain", Data: base64.StdEncoding.EncodeToString([]byte("hi"))},
	})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "first prompt", func() bool { return agent.promptCount() == 1 })
	blocks := agent.promptAt(t, 0).blocks
	if len(blocks) != 2 || blocks[0].Type != "text" || blocks[1].Type != "image" {
		t.Fatalf("blocks = %+v", blocks)
	}
	if blocks[1].MimeType != "image/png" || blocks[1].Data != image {
		t.Fatalf("image block = %+v", blocks[1])
	}
	agent.complete(0, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)

	if code := errorCode(h.Prompt("", []protocol.Attachment{
		{Name: "notes.txt", Mime: "text/plain", Data: base64.StdEncoding.EncodeToString([]byte("hi"))},
	})); code != protocol.ErrCodeInvalid {
		t.Fatalf("text-only attachment code = %q", code)
	}
}

func TestPromptFailureBecomesTurnError(t *testing.T) {
	h, agent := startHub(t)
	agent.mu.Lock()
	agent.promptErr = errors.New("adapter refused the prompt")
	agent.mu.Unlock()
	if err := h.Prompt("hello", nil); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	waitFor(t, "turn error", func() bool {
		state := h.Snapshot()
		return state.Status == protocol.StatusIdle && state.Error != ""
	})
	if message := h.Snapshot().Error; message != "adapter refused the prompt" {
		t.Fatalf("error = %q", message)
	}

	agent.mu.Lock()
	agent.promptErr = nil
	agent.mu.Unlock()
	if err := h.Prompt("again", nil); err != nil {
		t.Fatalf("second prompt: %v", err)
	}
	waitFor(t, "second prompt", func() bool { return agent.promptCount() == 2 })
	state := h.Snapshot()
	if state.Status != protocol.StatusWorking || state.Error != "" {
		t.Fatalf("second turn state = %q, error %q", state.Status, state.Error)
	}
	agent.complete(1, acp.PromptResult{}, nil)
	waitStatus(t, h, protocol.StatusIdle)
}
