package daemon

import (
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
	got := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]
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
	if other := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; other.Tokens["task"] != "" {
		t.Fatal("unbound pane acquired another session's title")
	}
	pane.AgentSession = ref
	pane.Agent = "claude"
	if other := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; other.Tokens["task"] != "" {
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

func TestAgentTitleUsesBoundClaudeSession(t *testing.T) {
	e := NewEngine(nil, nil, newMonitorTestRuntime())
	root := t.TempDir()
	id := "claude_session_1234"
	path := filepath.Join(root, "projects", "-repo", id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data := `{"type":"user","message":{"role":"user","content":"First request"}}` + "\n" +
		`{"type":"ai-title","sessionId":"claude_session_1234","aiTitle":"修复 Claude 会话标题"}` + "\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	e.Journal = &journal.Reader{ClaudeRoot: root}
	ref := &runtime.AgentSessionRef{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	pane := runtime.Pane{PaneID: "p1", Agent: "claude", AgentStatus: "blocked", AgentSession: ref, TerminalTitle: "Claude Code", Tokens: map[string]string{"phase": "review"}}
	got := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]
	if got.Tokens["task"] != "修复 Claude 会话标题" || got.TerminalTitle != "Claude Code" || got.Tokens["phase"] != "review" || pane.Tokens["task"] != "" {
		t.Fatalf("decorated=%+v", got)
	}
	if !observedPaneChanged(monitoredPane{pane: pane}, monitoredPane{pane: got}) {
		t.Fatal("generated Claude title did not trigger a snapshot poke")
	}
	wire, _ := json.Marshal(got)
	if strings.Contains(string(wire), id) || strings.Contains(string(wire), root) {
		t.Fatal("native binding leaked")
	}
	pane.Tokens["task"] = "Runtime name"
	if got := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; got.Tokens["task"] != "Runtime name" {
		t.Fatal("overrode runtime name")
	}
	delete(pane.Tokens, "task")
	pane.AgentSession = nil
	if got := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; got.Tokens["task"] != "" {
		t.Fatal("unbound pane borrowed Claude title")
	}
}

// A task launched through a slash command is a real submission even though the
// transcript's first record is a command, not a plain prompt.
func TestAgentTitleAndStatusForSlashStartedClaudeSession(t *testing.T) {
	e := NewEngine(nil, nil, newMonitorTestRuntime())
	root := t.TempDir()
	const id = "claude_slash_session"
	path := filepath.Join(root, "projects", "-repo", id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data := `{"type":"user","sessionId":"` + id + `","message":{"role":"user","content":"<command-message>pstack:poteto-mode</command-message>\n<command-name>/pstack:poteto-mode</command-name>\n<command-args>修复 Claude 会话标题</command-args>"}}` + "\n"
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	e.Journal = &journal.Reader{ClaudeRoot: root}
	ref := &runtime.AgentSessionRef{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: id}
	pane := runtime.Pane{PaneID: "p1", Agent: "claude", AgentStatus: "working", AgentSession: ref, TerminalTitle: "◑ Claude Code"}
	got := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]
	if got.AgentStatus != "working" || got.Tokens["task"] != "修复 Claude 会话标题" {
		t.Fatalf("decorated=%+v", got)
	}
	pane.AgentStatus = "done"
	if got := e.decorateAgentActivity(runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]; got.AgentStatus != "idle" {
		t.Fatalf("finished command-only turn=%+v", got)
	}
}
