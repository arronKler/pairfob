package daemon

import (
	"encoding/json"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

func TestAgentTitleUsesBoundFirstPromptOnPhoneAndMonitor(t *testing.T) {
	rt := newMonitorTestRuntime()
	e := NewEngine(nil, nil, rt)
	ref, appendEvent := taskActivityFixture(t, e)
	appendEvent(`{"type":"event_msg","payload":{"type":"user_message","message":"Fix the session title"}}`)
	appendEvent(`{"type":"event_msg","payload":{"type":"user_message","message":"continue"}}`)
	label := "My custom name"
	pane := runtime.Pane{PaneID: "p1", Agent: "codex", AgentStatus: "blocked", Cwd: "/repo/pairfob", TerminalTitle: "⠋ | pairfob", AgentSession: ref, Tokens: map[string]string{"phase": "review"}, Label: &label}
	snapshot := runtime.Snapshot{Panes: []runtime.Pane{pane}}
	got := e.decorateAgentActivity(snapshot).Panes[0]
	if got.Tokens["task"] != "Fix the session title" || got.TerminalTitle != pane.TerminalTitle || *got.Label != label || got.AgentStatus != "blocked" {
		t.Fatalf("decorated=%+v", got)
	}
	if snapshot.Panes[0].Tokens["task"] != "" {
		t.Fatal("mutated runtime snapshot")
	}
	data, _ := json.Marshal(got)
	if strings.Contains(string(data), ref.Value) || strings.Contains(string(data), e.Journal.CodexRoot) {
		t.Fatal("private binding leaked")
	}
	// Even in the same cwd, an unbound pane cannot borrow this task.
	pane.AgentSession = nil
	if other := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; other.Tokens["task"] != "" {
		t.Fatal("unbound pane acquired another session's title")
	}
	pane.AgentSession = ref
	pane.TerminalTitle = "Review title handling | pairfob"
	if next := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; next.Tokens["task"] != "Review title handling" {
		t.Fatalf("OSC title did not replace fallback: %+v", next)
	}
}

func TestTitleOnlyChangePokesButAnimationDoesNot(t *testing.T) {
	base := monitoredPane{pane: runtime.Pane{Agent: "codex", Cwd: "/repo/pairfob", TerminalTitle: "⠋ | pairfob"}}
	animated := base
	animated.pane.TerminalTitle = "⠙ | pairfob"
	if observedPaneChanged(base, animated) {
		t.Fatal("spinner frame caused a snapshot poke")
	}
	named := base
	named.pane.Tokens = map[string]string{"task": "Fix title"}
	if !observedPaneChanged(base, named) {
		t.Fatal("derived title change did not cause a snapshot poke")
	}
	named = base
	named.pane.TerminalTitle = "Fix title | pairfob"
	if !observedPaneChanged(base, named) {
		t.Fatal("OSC title change did not cause a snapshot poke")
	}
}
