package hub

import (
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

// onUpdate maps one ACP session update into transcript ops.
func (h *Hub) onUpdate(update *acp.Update) {
	if update == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state.Status == protocol.StatusExited {
		return
	}
	switch update.Kind {
	case acp.UpdateAgentMessageChunk:
		h.appendChunkLocked(protocol.KindAgent, update)
	case acp.UpdateAgentThoughtChunk:
		h.appendChunkLocked(protocol.KindThought, update)
	case acp.UpdateToolCall, acp.UpdateToolCallUpdate:
		h.upsertToolLocked(update.ToolCall)
	case acp.UpdatePlan:
		_ = h.applyLocked([]protocol.Op{{Op: protocol.OpSetPlan, Plan: planFromACP(update.Plan)}})
	case acp.UpdateCurrentMode:
		if update.ModeID == "" {
			return
		}
		modes := slices.Clone(h.state.Modes)
		_ = h.applyLocked([]protocol.Op{{Op: protocol.OpSetModes, Modes: modes, Mode: update.ModeID}})
	case acp.UpdateConfigOption:
		merged := mergeOptions(h.state.Options, optionsFromACP(update.ConfigOptions))
		_ = h.applyLocked([]protocol.Op{{Op: protocol.OpSetOptions, Options: merged}})
	case acp.UpdateUsage:
		h.applyUsageLocked(update.Usage)
	}
}

// appendChunkLocked extends the message entry for the chunk, creating it on
// the first chunk of a message. Adapters that omit messageId get one entry per
// turn and kind.
func (h *Hub) appendChunkLocked(kind string, update *acp.Update) {
	if update.Content.Type != "text" || update.Content.Text == "" {
		return
	}
	id := update.MessageID
	if id == "" {
		id = fmt.Sprintf("turn-%d-%s", h.turn, kind)
	}
	if _, ok := h.state.Entry(id); ok {
		_ = h.applyLocked([]protocol.Op{{Op: protocol.OpAppendText, ID: id, Text: update.Content.Text}})
		return
	}
	entry := protocol.Entry{
		ID:        id,
		Kind:      kind,
		Text:      update.Content.Text,
		Streaming: true,
		At:        nowMillis(),
	}
	ops := []protocol.Op{{Op: protocol.OpAppendEntry, Entry: &entry}}
	ops = append(ops, h.workingOpsLocked()...)
	_ = h.applyLocked(ops)
}

// workingOpsLocked returns a status op when a chunk arrives outside the
// working or blocked state of an active turn.
func (h *Hub) workingOpsLocked() []protocol.Op {
	if !h.active {
		return nil
	}
	if h.state.Status == protocol.StatusWorking || h.state.Status == protocol.StatusBlocked {
		return nil
	}
	return []protocol.Op{{Op: protocol.OpSetStatus, Status: protocol.StatusWorking}}
}

// upsertToolLocked creates a tool entry on first sight and merges later
// updates, which may carry only the changed fields.
func (h *Hub) upsertToolLocked(call *acp.ToolCall) {
	if call == nil || call.ToolCallID == "" {
		return
	}
	existing, ok := h.state.Entry(call.ToolCallID)
	if !ok || existing.Tool == nil {
		tool := toolFromACP(call)
		if tool.Status == "" {
			tool.Status = "pending"
		}
		entry := protocol.Entry{
			ID:   call.ToolCallID,
			Kind: protocol.KindTool,
			Tool: &tool,
			At:   nowMillis(),
		}
		ops := []protocol.Op{{Op: protocol.OpAppendEntry, Entry: &entry}}
		ops = append(ops, h.workingOpsLocked()...)
		_ = h.applyLocked(ops)
		return
	}

	tool := *existing.Tool
	tool.Content = slices.Clone(existing.Tool.Content)
	tool.Locations = slices.Clone(existing.Tool.Locations)
	if call.Title != "" {
		tool.Title = call.Title
	}
	if call.Kind != "" {
		tool.Kind = call.Kind
	}
	if call.Status != "" {
		tool.Status = call.Status
	}
	if call.Content != nil {
		tool.Content = toolContentFromACP(call.Content)
	}
	if call.Locations != nil {
		tool.Locations = toolLocationsFromACP(call.Locations)
	}
	entry := *existing
	entry.Tool = &tool
	_ = h.applyLocked([]protocol.Op{{Op: protocol.OpSetEntry, Entry: &entry}})
}

func (h *Hub) applyUsageLocked(update *acp.UsageUpdate) {
	if update == nil {
		return
	}
	usage := protocol.Usage{Used: int64(update.Used), Size: int64(update.Size)}
	if h.state.Usage != nil {
		usage.CostUSD = h.state.Usage.CostUSD
	}
	if update.Cost != nil {
		usage.CostUSD = update.Cost.Amount
	}
	_ = h.applyLocked([]protocol.Op{{Op: protocol.OpSetUsage, Usage: &usage}})
}

// onPermission records the request and lets an enabled auto-accept policy
// answer it before any view sees a prompt.
func (h *Hub) onPermission(request *acp.PermissionRequest) {
	if request == nil || request.RequestID == "" {
		return
	}
	permission := permissionFromACP(request)
	h.mu.Lock()
	if h.state.Status == protocol.StatusExited {
		h.mu.Unlock()
		return
	}
	_ = h.applyLocked([]protocol.Op{
		{Op: protocol.OpSetPermission, Permission: &permission},
		{Op: protocol.OpSetStatus, Status: protocol.StatusBlocked},
	})
	auto := h.state.AutoAccept
	h.mu.Unlock()
	if auto {
		h.autoAnswer(permission)
	}
}

// onExit records the adapter exit and keeps the transcript readable. A later
// exit cause can refine a startup error, but a clean exit never erases one.
func (h *Hub) onExit(exit *acp.Exit) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.active = false
	message := exitMessage(exit)
	if h.state.Status == protocol.StatusExited {
		if message != "" && h.state.Error != message {
			_ = h.applyLocked([]protocol.Op{{Op: protocol.OpSetError, Error: message}})
		}
		return
	}
	ops := h.clearStreamingLocked()
	if h.state.Permission != nil {
		ops = append(ops, protocol.Op{Op: protocol.OpSetPermission})
	}
	if len(h.state.Queue) > 0 {
		ops = append(ops, protocol.Op{Op: protocol.OpSetQueue, Queue: []protocol.QueuedPrompt{}})
		h.queued = make(map[string][]acp.ContentBlock)
	}
	ops = append(ops,
		protocol.Op{Op: protocol.OpSetError, Error: message},
		protocol.Op{Op: protocol.OpSetStatus, Status: protocol.StatusExited},
	)
	_ = h.applyLocked(ops)
}

const maxErrorBytes = 2000

// exitMessage reports a crash but keeps a clean exit free of an error string.
func exitMessage(exit *acp.Exit) string {
	if exit == nil {
		return ""
	}
	err := exit.Err
	clean := err == nil || errors.Is(err, io.EOF) || errors.Is(err, acp.ErrClosed)
	if clean {
		if exit.Code > 0 {
			return fmt.Sprintf("agent exited with code %d", exit.Code)
		}
		return ""
	}
	message := err.Error()
	if line := lastLine(exit.Stderr); line != "" && !strings.Contains(message, line) {
		message += ": " + line
	}
	if len(message) > maxErrorBytes {
		message = message[:maxErrorBytes] + "…"
	}
	return message
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}
