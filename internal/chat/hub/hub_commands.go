package hub

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

// Prompt starts a turn, or queues it behind the active one.
func (h *Hub) Prompt(text string, attachments []protocol.Attachment) error {
	blocks, err := promptBlocks(text, attachments)
	if err != nil {
		return commandErrorf(protocol.ErrCodeInvalid, "%v", err)
	}
	h.mu.Lock()
	switch {
	case h.state.Status == protocol.StatusExited:
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeAgent, "agent has exited")
	case !h.ready:
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeBusy, "session is still starting")
	case h.agent == nil:
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeAgent, "agent is not attached")
	}
	if h.active {
		if len(h.state.Queue) >= maxQueue {
			h.mu.Unlock()
			return commandErrorf(protocol.ErrCodeBusy, "the prompt queue is full")
		}
		h.nextQueue++
		id := fmt.Sprintf("q%d", h.nextQueue)
		queue := append(slices.Clone(h.state.Queue), protocol.QueuedPrompt{ID: id, Text: text})
		h.queued[id] = blocks
		err := h.applyLocked([]protocol.Op{{Op: protocol.OpSetQueue, Queue: queue}})
		h.mu.Unlock()
		if err != nil {
			return commandErrorf(protocol.ErrCodeAgent, "queue prompt: %v", err)
		}
		return nil
	}
	launch, err := h.beginTurnLocked(text, blocks)
	h.mu.Unlock()
	if err != nil {
		return commandErrorf(protocol.ErrCodeAgent, "start turn: %v", err)
	}
	go launch()
	return nil
}

// Cancel asks the agent to stop the active turn. The transcript stays in the
// working state until the prompt response returns.
func (h *Hub) Cancel() error {
	h.mu.Lock()
	agent, active, sessionID := h.agent, h.active, h.sessionID
	h.mu.Unlock()
	if !active || agent == nil {
		return nil
	}
	if err := agent.Cancel(sessionID); err != nil {
		return commandErrorf(protocol.ErrCodeAgent, "cancel turn: %v", err)
	}
	return nil
}

// Answer settles the pending permission request.
func (h *Hub) Answer(requestID, optionID string) error {
	h.mu.Lock()
	permission := h.state.Permission
	agent := h.agent
	if permission == nil || permission.ID != requestID {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodePermissionGone, "permission request %q is no longer pending", requestID)
	}
	if _, ok := h.state.PermissionOption(optionID); !ok {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeInvalid, "unknown permission option %q", optionID)
	}
	h.mu.Unlock()
	if agent == nil {
		return commandErrorf(protocol.ErrCodeAgent, "agent is not attached")
	}
	err := agent.AnswerPermission(requestID, optionID)
	h.clearPermission(requestID)
	switch {
	case errors.Is(err, acp.ErrPermissionGone):
		return commandErrorf(protocol.ErrCodePermissionGone, "permission request %q is no longer pending", requestID)
	case err != nil:
		return commandErrorf(protocol.ErrCodeAgent, "answer permission: %v", err)
	}
	return nil
}

// SetMode switches the session mode. The adapter confirms it with a
// current_mode_update, which is what changes the transcript.
func (h *Hub) SetMode(modeID string) error {
	h.mu.Lock()
	if !h.ready {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeBusy, "session is still starting")
	}
	agent, sessionID := h.agent, h.sessionID
	modes := h.state.Modes
	if len(modes) == 0 {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeUnsupported, "the agent does not advertise modes")
	}
	found := slices.ContainsFunc(modes, func(mode protocol.Mode) bool { return mode.ID == modeID })
	h.mu.Unlock()
	if !found {
		return commandErrorf(protocol.ErrCodeNotFound, "unknown mode %q", modeID)
	}
	if agent == nil {
		return commandErrorf(protocol.ErrCodeAgent, "agent is not attached")
	}
	if err := agent.SetMode(context.Background(), sessionID, modeID); err != nil {
		return commandErrorf(protocol.ErrCodeAgent, "set mode: %v", err)
	}
	return nil
}

// SetOption changes one adapter setting such as the model or effort.
func (h *Hub) SetOption(optionID, value string) error {
	h.mu.Lock()
	if !h.ready {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeBusy, "session is still starting")
	}
	agent, sessionID := h.agent, h.sessionID
	options := h.state.Options
	if len(options) == 0 {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeUnsupported, "the agent does not advertise options")
	}
	index := slices.IndexFunc(options, func(option protocol.Option) bool { return option.ID == optionID })
	if index < 0 {
		h.mu.Unlock()
		return commandErrorf(protocol.ErrCodeNotFound, "unknown option %q", optionID)
	}
	choices := options[index].Choices
	valid := len(choices) == 0 || slices.ContainsFunc(choices, func(choice protocol.OptionChoice) bool {
		return choice.Value == value
	})
	h.mu.Unlock()
	if !valid {
		return commandErrorf(protocol.ErrCodeInvalid, "unknown value %q for option %q", value, optionID)
	}
	if agent == nil {
		return commandErrorf(protocol.ErrCodeAgent, "agent is not attached")
	}
	if err := agent.SetConfigOption(context.Background(), sessionID, optionID, value); err != nil {
		return commandErrorf(protocol.ErrCodeAgent, "set option: %v", err)
	}
	return nil
}

// Unqueue drops one waiting prompt. An idle queue is not an error.
func (h *Hub) Unqueue(queueID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.state.Queue) == 0 {
		return nil
	}
	index := slices.IndexFunc(h.state.Queue, func(item protocol.QueuedPrompt) bool { return item.ID == queueID })
	if index < 0 {
		return commandErrorf(protocol.ErrCodeNotFound, "unknown queued prompt %q", queueID)
	}
	remaining := slices.Delete(slices.Clone(h.state.Queue), index, index+1)
	delete(h.queued, queueID)
	if err := h.applyLocked([]protocol.Op{{Op: protocol.OpSetQueue, Queue: remaining}}); err != nil {
		return commandErrorf(protocol.ErrCodeAgent, "unqueue: %v", err)
	}
	return nil
}

// SetAutoAccept enables or disables automatic permission answers. Enabling it
// while a request is pending answers that request immediately.
func (h *Hub) SetAutoAccept(enabled bool) error {
	h.mu.Lock()
	err := h.applyLocked([]protocol.Op{{Op: protocol.OpSetAutoAccept, Enabled: &enabled}})
	permission := clonePermission(h.state.Permission)
	h.mu.Unlock()
	if err != nil {
		return commandErrorf(protocol.ErrCodeAgent, "set auto accept: %v", err)
	}
	if enabled && permission != nil {
		h.autoAnswer(*permission)
	}
	return nil
}

// beginTurnLocked appends the user entry and returns the goroutine that sends
// the prompt. Callers hold h.mu and launch the goroutine after unlocking.
func (h *Hub) beginTurnLocked(text string, blocks []acp.ContentBlock) (func(), error) {
	h.turn++
	entry := protocol.Entry{
		ID:   fmt.Sprintf("user-%d", h.turn),
		Kind: protocol.KindUser,
		Text: text,
		At:   nowMillis(),
	}
	if err := h.applyLocked([]protocol.Op{
		{Op: protocol.OpAppendEntry, Entry: &entry},
		{Op: protocol.OpSetStatus, Status: protocol.StatusWorking},
		{Op: protocol.OpSetError, Error: ""},
	}); err != nil {
		h.turn--
		return nil, err
	}
	h.active = true
	agent, sessionID, turn := h.agent, h.sessionID, h.turn
	return func() {
		result, err := agent.Prompt(context.Background(), sessionID, blocks)
		h.finishTurn(turn, result, err)
	}, nil
}

// finishTurn closes the prompt that started at turn, then drains one queued
// prompt.
func (h *Hub) finishTurn(turn int, _ acp.PromptResult, promptErr error) {
	h.mu.Lock()
	if h.turn != turn || !h.active {
		h.mu.Unlock()
		return
	}
	h.active = false
	if h.state.Status == protocol.StatusExited {
		h.mu.Unlock()
		return
	}
	ops := h.clearStreamingLocked()
	if h.state.Permission != nil {
		ops = append(ops, protocol.Op{Op: protocol.OpSetPermission})
	}
	message := ""
	if promptErr != nil {
		message = promptErr.Error()
	}
	ops = append(ops,
		protocol.Op{Op: protocol.OpSetError, Error: message},
		protocol.Op{Op: protocol.OpSetStatus, Status: protocol.StatusIdle},
	)
	_ = h.applyLocked(ops)
	launch := h.drainLocked()
	h.mu.Unlock()
	if launch != nil {
		go launch()
	}
}

// drainLocked starts the oldest queued prompt. Callers hold h.mu and launch
// the returned goroutine after unlocking.
func (h *Hub) drainLocked() func() {
	if len(h.state.Queue) == 0 {
		return nil
	}
	next := h.state.Queue[0]
	blocks := h.queued[next.ID]
	delete(h.queued, next.ID)
	remaining := slices.Clone(h.state.Queue[1:])
	if err := h.applyLocked([]protocol.Op{{Op: protocol.OpSetQueue, Queue: remaining}}); err != nil {
		return nil
	}
	launch, err := h.beginTurnLocked(next.Text, blocks)
	if err != nil {
		return nil
	}
	return launch
}

// clearStreamingLocked stops the cursor on every streaming entry.
func (h *Hub) clearStreamingLocked() []protocol.Op {
	ops := make([]protocol.Op, 0, len(h.state.Entries))
	for i := range h.state.Entries {
		if !h.state.Entries[i].Streaming {
			continue
		}
		streaming := false
		ops = append(ops, protocol.Op{
			Op:        protocol.OpSetStreaming,
			ID:        h.state.Entries[i].ID,
			Streaming: &streaming,
		})
	}
	return ops
}

func (h *Hub) clearPermission(requestID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state.Permission == nil || h.state.Permission.ID != requestID {
		return
	}
	status := protocol.StatusIdle
	if h.active {
		status = protocol.StatusWorking
	}
	_ = h.applyLocked([]protocol.Op{
		{Op: protocol.OpSetPermission},
		{Op: protocol.OpSetStatus, Status: status},
	})
}

// autoAnswer picks an allow option for the pending request.
func (h *Hub) autoAnswer(permission protocol.Permission) {
	option, ok := allowOption(permission.Options)
	if !ok {
		return
	}
	h.mu.Lock()
	agent := h.agent
	h.mu.Unlock()
	if agent == nil {
		return
	}
	if err := agent.AnswerPermission(permission.ID, option); err != nil {
		return
	}
	h.clearPermission(permission.ID)
}
