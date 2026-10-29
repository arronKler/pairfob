package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestTerminalOpenBypassesSlowDisplayRead(t *testing.T) {
	rt := &blockedDescribeRuntime{Fake: runtime.NewFake(), started: make(chan struct{}, 1), release: make(chan struct{})}
	e, s, send, read := pingSession(t, rt)
	s.readQueue = make(chan rpcRequest, sessionReadQueueSize)
	go e.runSessionRPC(s)
	defer close(rt.release)
	defer closeSessionTerminal(s)
	send("slow", "GetConfig")
	<-rt.started
	s.rpcQueue <- rpcRequest{id: "terminal", op: "TerminalOpen", params: json.RawMessage(`{"operation_id":"op_terminal_probe_123","pane_id":"w0:p1","cols":80,"rows":24}`), receivedAt: time.Now()}
	reply := read()
	if reply["id"] != "terminal" || reply["ok"] != true {
		t.Fatal(reply)
	}
	terminalID := reply["result"].(map[string]any)["terminal_id"].(string)
	commands := []struct {
		op     string
		params map[string]any
	}{
		{"TerminalInput", map[string]any{"seq": 1, "data": "aGk="}},
		{"TerminalResize", map[string]any{"seq": 2, "cols": 100, "rows": 30}},
		{"TerminalClose", map[string]any{}},
	}
	for i, command := range commands {
		command.params["operation_id"] = fmt.Sprintf("op_terminal_queued_%d", i)
		command.params["terminal_id"] = terminalID
		params, err := json.Marshal(command.params)
		if err != nil {
			t.Fatal(err)
		}
		s.rpcQueue <- rpcRequest{id: command.op, op: command.op, params: params, receivedAt: time.Now()}
	}
	for _, command := range commands {
		for {
			reply := read()
			if reply["id"] == nil {
				continue
			} // Terminal frames share the ordered envelope stream.
			if reply["id"] != command.op || reply["ok"] != true {
				t.Fatal(reply)
			}
			break
		}
	}
}

func TestDisplayReadAdmissionIsBounded(t *testing.T) {
	e, s, send, read := pingSession(t, runtime.NewFake())
	s.readQueue = make(chan rpcRequest, sessionReadQueueSize)
	for i := 0; i < sessionReadQueueSize; i++ {
		send("queued", "Snapshot")
	}
	send("overflow", "Snapshot")
	if reply := read(); reply["ok"] != false || reply["error"].(map[string]any)["code"] != "backpressure" {
		t.Fatal(reply)
	}
	if len(s.rpcQueue) != 0 || len(s.readQueue) != sessionReadQueueSize {
		t.Fatal("read escaped its queue")
	}
	_ = e
}

type terminalBudgetRuntime struct {
	*runtime.Fake
	snapshotDeadline time.Time
	openDeadline     time.Time
	observed         bool
}

func (r *terminalBudgetRuntime) Observe(ctx context.Context, session runtime.SessionRef, query runtime.Query) (runtime.View, error) {
	r.observed = true
	r.snapshotDeadline, _ = ctx.Deadline()
	return r.Fake.Observe(ctx, session, query)
}
func (r *terminalBudgetRuntime) OpenTerminal(ctx context.Context, open runtime.TerminalOpen) (runtime.TerminalController, error) {
	r.openDeadline, _ = ctx.Deadline()
	return r.Fake.OpenTerminal(ctx, open)
}

func TestTerminalOpenSharesDeadlineAcrossSnapshotAndBridge(t *testing.T) {
	rt := &terminalBudgetRuntime{Fake: runtime.NewFake()}
	e, s, _, read := pingSession(t, rt)
	defer closeSessionTerminal(s)
	start := time.Now()
	e.dispatchQueued(s, rpcRequest{id: "open", op: "TerminalOpen", receivedAt: start, params: json.RawMessage(`{"operation_id":"op_terminal_budget_123","pane_id":"w0:p1","cols":80,"rows":24}`)})
	if reply := read(); reply["ok"] != true {
		t.Fatal(reply)
	}
	if !rt.snapshotDeadline.Equal(start.Add(terminalOpenBudget)) || !rt.openDeadline.Equal(rt.snapshotDeadline) {
		t.Fatalf("deadlines differ: %v %v", rt.snapshotDeadline, rt.openDeadline)
	}
}

func TestExpiredTerminalOpenDoesNotExecute(t *testing.T) {
	rt := &terminalBudgetRuntime{Fake: runtime.NewFake()}
	e, s, _, read := pingSession(t, rt)
	e.dispatchQueued(s, rpcRequest{id: "expired", op: "TerminalOpen", receivedAt: time.Now().Add(-terminalOpenBudget - time.Second), params: json.RawMessage(`{}`)})
	if reply := read(); reply["ok"] != false {
		t.Fatal(reply)
	}
	if rt.observed || !rt.openDeadline.IsZero() {
		t.Fatal("expired request reached runtime")
	}
}
