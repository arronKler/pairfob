package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/journal"
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
	got := e.decorateAgentActivity(context.Background(), runtime.DefaultSession(), snapshot).Panes[0]
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
	if other := e.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; other.Tokens["task"] != "" {
		t.Fatal("unbound pane acquired another session's title")
	}
	pane.AgentSession = ref
	pane.TerminalTitle = "Review title handling | pairfob"
	if next := e.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; next.Tokens["task"] != "Review title handling" {
		t.Fatalf("OSC title did not replace fallback: %+v", next)
	}
}

func TestAgentTitleUsesBoundPiSession(t *testing.T) {
	rt := newMonitorTestRuntime()
	e := NewEngine(nil, nil, rt)
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "--repo--", "2026-10-20T00-00-00-000Z_pi_session_1234.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"type":"session","version":3,"id":"pi_session_1234","cwd":"/repo/pairfob"}`,
		`{"type":"message","id":"user0001","parentId":null,"message":{"role":"user","content":"修复 Pi 会话标题"}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	e.Journal = &journal.Reader{PiRoot: root}
	ref := &runtime.AgentSessionRef{Source: "herdr:pi", Agent: "pi", Kind: "path", Value: path}
	pane := runtime.Pane{PaneID: "p1", Agent: "pi", AgentStatus: "blocked", Cwd: "/repo/pairfob", TerminalTitle: "π - pairfob", AgentSession: ref, Tokens: map[string]string{"phase": "review"}}
	got := e.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]
	if got.Tokens["task"] != "修复 Pi 会话标题" || got.TerminalTitle != pane.TerminalTitle || got.Tokens["phase"] != "review" {
		t.Fatalf("decorated=%+v", got)
	}
	if pane.Tokens["task"] != "" {
		t.Fatal("mutated runtime snapshot")
	}
	data, _ := json.Marshal(got)
	if strings.Contains(string(data), ref.Value) || strings.Contains(string(data), e.Journal.PiRoot) {
		t.Fatal("private binding leaked")
	}
	// Even in the same cwd, an unbound pane cannot borrow this task.
	pane.AgentSession = nil
	if other := e.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; other.Tokens["task"] != "" {
		t.Fatal("unbound pane acquired another session's title")
	}
	pane.AgentSession = ref
	pane.Agent = "claude"
	if other := e.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; other.Tokens["task"] != "" {
		t.Fatal("another agent borrowed the Pi title")
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
