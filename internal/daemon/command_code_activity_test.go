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

func TestCommandCodeLiveToolUsesExistingActivityWithoutPrivateBinding(t *testing.T) {
	leaf := "private-leaf"
	ref := &runtime.AgentSessionRef{Source: "pairfob:cmd", Agent: "cmd", Kind: "id", Value: "private-session", Leaf: &leaf, LiveActivity: &runtime.PaneActivity{Type: "tool", Name: "shell", State: "error", At: 1234}}
	e := &Engine{Journal: &journal.Reader{}}
	pane := runtime.Pane{PaneID: "w1:p1", Agent: "cmd", AgentStatus: "working", AgentSession: ref}
	e.decorateTurnActivity(&pane)
	if pane.Activity == nil || pane.Activity.Name != "shell" || pane.Activity.State != "error" {
		t.Fatalf("activity: %+v", pane.Activity)
	}
	data, _ := json.Marshal(pane)
	if strings.Contains(string(data), "private-") || strings.Contains(string(data), "pairfob:cmd") {
		t.Fatal("binding leaked")
	}
	if got := journalRef(ref); got.Leaf == nil || *got.Leaf != leaf {
		t.Fatal("lost selected branch")
	}
}

func TestCommandCodeThinkingBeforeFirstPersistedMessageStaysWorking(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "projects", "repo")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "command-session.jsonl"), []byte("{\"type\":\"session\",\"version\":3,\"id\":\"command-session\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	leaf := ""
	ref := &runtime.AgentSessionRef{Source: "pairfob:cmd", Agent: "cmd", Kind: "id", Value: "command-session", Leaf: &leaf}
	e := &Engine{Journal: &journal.Reader{NativeRoots: map[string]string{"cmd": root}}}
	if activity := e.Journal.ReadActivity(journalRef(ref)); !activity.Known || activity.Key != "" {
		t.Fatalf("expected empty persisted branch: %+v", activity)
	}
	pane := runtime.Pane{Agent: "cmd", AgentStatus: "working", AgentSession: ref}
	e.decorateTaskStatus(&pane)
	if pane.AgentStatus != "working" {
		t.Fatal("native run_start was overwritten before persistence")
	}
}
