package daemon

import (
	"context"
	"time"
)

const sessionReadQueueSize = 8
const terminalOpenBudget = 8 * time.Second

// Slow display reads have one bounded worker. Mutations, including terminal
// commands and transport commits, retain their original serial order.
func sessionRead(op string) bool {
	switch op {
	case "GetConfig", "Snapshot", "PaneRead", "History", "AgentInspect",
		"AgentTrace", "AgentTraceSummary", "AgentTraceModelSummary", "AgentTraceDetail":
		return true
	}
	return false
}

func (e *Engine) dispatchQueued(s *sess, request rpcRequest) {
	if request.op != "TerminalOpen" {
		e.dispatch(s, request.id, request.op, request.params)
		return
	}
	started := request.receivedAt
	if started.IsZero() {
		started = time.Now()
	}
	ctx, cancel := context.WithDeadline(context.Background(), started.Add(terminalOpenBudget))
	defer cancel()
	if ctx.Err() != nil {
		e.replyErr(s, request.id, "herdr_offline", "terminal open expired before execution")
		return
	}
	e.rpcTerminalOpenContext(ctx, s, request.id, request.params)
}
