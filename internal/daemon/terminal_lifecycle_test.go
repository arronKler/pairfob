package daemon

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

type delayedTerminalRuntime struct {
	*runtime.Fake
	started    chan struct{}
	release    chan struct{}
	controller *trackedTerminalController
}

type trackedTerminalController struct {
	runtime.TerminalController
	closed atomic.Bool
}

func (c *trackedTerminalController) Close() error {
	c.closed.Store(true)
	return c.TerminalController.Close()
}

func (r *delayedTerminalRuntime) OpenTerminal(ctx context.Context, open runtime.TerminalOpen) (runtime.TerminalController, error) {
	controller, err := r.Fake.OpenTerminal(ctx, open)
	if err != nil {
		return nil, err
	}
	r.controller = &trackedTerminalController{TerminalController: controller}
	close(r.started)
	<-r.release
	return r.controller, nil
}

func TestTerminalOpenFinishingAfterDisconnectClosesController(t *testing.T) {
	rt := &delayedTerminalRuntime{Fake: runtime.NewFake(), started: make(chan struct{}), release: make(chan struct{})}
	e, s, _, _ := pingSession(t, rt)
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.rpcTerminalOpen(s, "open", json.RawMessage(`{"operation_id":"op_terminal_disconnected","pane_id":"w0:p1","cols":80,"rows":24}`))
	}()
	<-rt.started
	e.ResetTransport()
	close(rt.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("late open did not finish")
	}
	if !rt.controller.closed.Load() {
		t.Fatal("late controller leaked after disconnect")
	}
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	if s.terminal != nil {
		t.Fatal("disconnected session acquired terminal")
	}
}
