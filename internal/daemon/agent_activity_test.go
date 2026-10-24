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

func taskActivityFixture(t *testing.T, engine *Engine) (*runtime.AgentSessionRef, func(string)) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "sessions", "rollout-activity_session_1234.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	engine.Journal = &journal.Reader{CodexRoot: root}
	appendEvent := func(event string) {
		t.Helper()
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.WriteString(event + "\n")
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
	}
	appendEvent(`{"type":"session_meta","payload":{}}`)
	return &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "activity_session_1234"}, appendEvent
}

func TestAgentActivityStartupTaskAndReconnect(t *testing.T) {
	rt := newMonitorTestRuntime()
	engine := NewEngine(nil, nil, rt)
	ref, appendEvent := taskActivityFixture(t, engine)
	ready, pending := true, true
	pane := runtime.Pane{PaneID: "p1", Agent: "codex", AgentInstanceID: "one", AgentSession: ref, InteractiveReady: &ready, LaunchPending: &pending}
	observe := func(raw, want string) runtime.Pane {
		t.Helper()
		pane.AgentStatus = raw
		rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{pane}})
		phone, err := engine.snapshot(nil)
		if err != nil {
			t.Fatal(err)
		}
		monitor, err := engine.monitorSnapshot(context.Background(), runtime.DefaultSession())
		if err != nil {
			t.Fatal(err)
		}
		if phone.Panes[0].AgentStatus != want || monitor.Panes[0].AgentStatus != want {
			t.Fatalf("%s -> phone=%s monitor=%s want=%s", raw, phone.Panes[0].AgentStatus, monitor.Panes[0].AgentStatus, want)
		}
		if pane.AgentStatus != raw {
			t.Fatal("raw observation mutated")
		}
		return phone.Panes[0]
	}
	observe("working", "idle")
	observe("done", "idle")
	observe("blocked", "blocked")
	pane.AgentSession = nil
	observe("working", "idle")
	observe("done", "idle")
	pane.AgentSession = ref
	pending = false
	observe("working", "idle")
	observe("done", "idle")
	appendEvent(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn1"}}`)
	observe("working", "working")
	observe("done", "working") // A stale runtime completion must not finish a new turn.
	appendEvent(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn1"}}`)
	completed := observe("done", "done")
	encoded, _ := json.Marshal(completed)
	if strings.Contains(string(encoded), completed.TaskEvidence) || strings.Contains(string(encoded), ref.Value) {
		t.Fatal("private task evidence leaked")
	}
	// A fresh daemon can reconstruct task evidence without phone-side memory.
	restarted := NewEngine(nil, nil, rt)
	restarted.Journal = &journal.Reader{CodexRoot: engine.Journal.CodexRoot}
	after, err := restarted.snapshot(nil)
	if err != nil || after.Panes[0].AgentStatus != "done" {
		t.Fatalf("reconnect=%+v err=%v", after, err)
	}
	pane.AgentSession = &runtime.AgentSessionRef{Agent: "codex", Kind: "id", Value: "replacement_1234"}
	pane.AgentInstanceID = "two"
	observe("done", "done") // An unavailable replacement transcript is not known-empty.
	observe("unknown", "unknown")
	engine.Journal = nil
	observe("done", "done")
}

func TestAgentActivityMissingEvidenceDoesNotEraseRuntimeCompletion(t *testing.T) {
	engine := NewEngine(nil, nil, newMonitorTestRuntime())
	ref, appendEvent := taskActivityFixture(t, engine)
	pane := runtime.Pane{PaneID: "p1", Agent: "codex", AgentStatus: "done", AgentSession: ref}
	assertStatus := func(want string) {
		t.Helper()
		got := engine.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]
		if got.AgentStatus != want {
			t.Fatalf("status=%s want=%s", got.AgentStatus, want)
		}
	}
	assertStatus("idle") // Positively empty startup still cannot finish a task.
	appendEvent(`{"type":"event_msg","payload":{"type":"task_complete"}}`)
	assertStatus("done")
	pane.AgentSession = nil
	assertStatus("done")
	pane.AgentSession = ref
	path := filepath.Join(engine.Journal.CodexRoot, "sessions", "rollout-activity_session_1234.jsonl")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	assertStatus("done")
	// A large metadata record can push all task evidence outside the bounded
	// tail. It cannot prove the runtime's completion was merely a startup.
	appendEvent(`{"type":"session_meta","payload":{"padding":"` + strings.Repeat("x", 600<<10) + `"}}`)
	assertStatus("done")
}

func TestAgentActivityPushRequiresNewTaskEvidence(t *testing.T) {
	rt := newMonitorTestRuntime()
	engine := NewEngine(nil, nil, rt)
	engine.PushEnabled = true
	ref, appendEvent := taskActivityFixture(t, engine)
	state := sessionMonitorState{panes: map[string]monitoredPane{}}
	sequence := uint64(1)
	pane := runtime.Pane{PaneID: "p1", Agent: "codex", AgentInstanceID: "one", AgentSession: ref, StateChangeSeq: &sequence}
	pushes := []HerdPush{}
	observe := func(status string) {
		pane.AgentStatus = status
		rt.setSnapshot(runtime.Snapshot{Panes: []runtime.Pane{pane}})
		engine.reconcileRuntimeSession(context.Background(), runtime.DefaultSession(), true, &state, func(string, string) {}, func(push HerdPush) { pushes = append(pushes, push) })
	}
	observe("working")
	sequence++
	observe("done")
	if len(pushes) != 0 {
		t.Fatal("startup sent completion")
	}
	appendEvent(`{"type":"event_msg","payload":{"type":"task_started"}}`)
	observe("working")
	appendEvent(`{"type":"event_msg","payload":{"type":"task_complete"}}`)
	sequence++
	observe("done")
	if len(pushes) != 1 || pushes[0].Kind != PushDone {
		t.Fatalf("real completion=%+v", pushes)
	}
	sequence++
	observe("done")
	observe("idle")
	observe("working")
	observe("done")
	if len(pushes) != 1 {
		t.Fatal("same transcript completion rearmed on runtime status churn")
	}
	appendEvent(`{"type":"event_msg","payload":{"type":"task_started"}}`)
	appendEvent(`{"type":"event_msg","payload":{"type":"task_complete"}}`)
	sequence++
	observe("done")
	if len(pushes) != 2 {
		t.Fatal("missed fast task between snapshots")
	}
	pending := true
	pane.LaunchPending = &pending
	observe("working")
	pending = false
	sequence++
	observe("done")
	if len(pushes) != 2 {
		t.Fatal("resuming old history sent a new completion")
	}
	pane.AgentInstanceID = "replacement"
	sequence++
	observe("done")
	if len(pushes) != 2 {
		t.Fatal("replacement occupant replayed completion")
	}
	observe("blocked")
	if len(pushes) != 3 || pushes[2].Kind != PushNeedsYou {
		t.Fatal("confirmation was suppressed")
	}
}
