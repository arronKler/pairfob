package daemon

import (
	"errors"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestTerminalOpenDoesNotJoinPresentationSnapshot(t *testing.T) {
	e, client := runtimeRPCClient(t, runtime.NewFake())
	key, _ := observeKey(nil, runtime.SnapshotQuery{})
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		_, _ = e.reads.do(key, func() (runtime.View, error) {
			close(started)
			<-release // A list refresh is still enriching its snapshot.
			return runtime.SnapshotView{}, nil
		})
	}()
	<-started
	defer func() { close(release); <-done }()
	result := make(chan error, 1)
	go func() {
		_, err := client.RPC("TerminalOpen", map[string]any{
			"operation_id": terminalOperation(0), "pane_id": "w0:p1", "cols": 80, "rows": 24,
		})
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("terminal open waited for presentation metadata")
	}
}

func TestTerminalLookupKeepsLiveMembershipWithoutPresentation(t *testing.T) {
	rt := newMonitorTestRuntime()
	e := NewEngine(nil, nil, rt)
	ref, appendEvent := taskActivityFixture(t, e)
	appendEvent(`{"type":"event_msg","payload":{"type":"user_message","message":"Display title"}}`)
	rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{{
		PaneID: "p1", Agent: "codex", AgentStatus: "blocked", AgentSession: ref,
	}}})
	shown, err := e.snapshot(nil)
	if err != nil || shown.Panes[0].Tokens["task"] != "Display title" {
		t.Fatalf("display snapshot lost title: %+v, %v", shown, err)
	}
	pane, err := e.findTerminalPane(nil, "p1")
	if err != nil || pane == nil || pane.Tokens["task"] != "" || pane.HistoryAvailable {
		t.Fatalf("terminal lookup included presentation: %+v, %v", pane, err)
	}
	rt.setSnapshot(runtime.Snapshot{})
	if pane, err := e.findTerminalPane(nil, "p1"); err != nil || pane != nil {
		t.Fatalf("removed pane still available: %+v, %v", pane, err)
	}
	rt.observeErr = errors.New("runtime offline")
	if pane, err := e.findTerminalPane(nil, "p1"); err == nil || pane != nil {
		t.Fatalf("runtime failure did not fail closed: %+v, %v", pane, err)
	}
}
