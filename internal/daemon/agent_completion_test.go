package daemon

import (
	"context"
	"encoding/json"
	"regexp"
	"testing"

	"pairfob/internal/runtime"
)

func TestCompletionIdentitySurvivesRuntimeChurn(t *testing.T) {
	engine := NewEngine(nil, nil, newMonitorTestRuntime())
	ref, appendEvent := taskActivityFixture(t, engine)
	sequence := uint64(7)
	pane := runtime.Pane{PaneID: "p1", TerminalID: "t1", Agent: "codex", AgentInstanceID: "a1", AgentSession: ref, StateChangeSeq: &sequence}
	observe := func(status string) runtime.Pane {
		t.Helper()
		pane.AgentStatus = status
		// A runtime-supplied value must never be trusted, including unknown panes.
		pane.CompletionID = "untrusted"
		return engine.decorateAgentActivity(context.Background(), runtime.DefaultSession(), runtime.Snapshot{Panes: []runtime.Pane{pane}}).Panes[0]
	}
	if got := observe("done"); got.CompletionID != "" {
		t.Fatal("empty startup has completion evidence")
	}
	appendEvent(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}`)
	appendEvent(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"one"}}`)
	first := observe("done")
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(first.CompletionID) {
		t.Fatalf("invalid completion ID: %q", first.CompletionID)
	}
	for _, status := range []string{"idle", "working", "blocked", "unknown"} {
		sequence++
		if got := observe(status); got.CompletionID != "" {
			t.Fatalf("%s has completion evidence", status)
		}
		sequence++
		if got := observe("done"); got.CompletionID != first.CompletionID {
			t.Fatalf("%s recovery changed completion ID", status)
		}
	}
	appendEvent(`{"type":"session_meta","payload":{"metadata":"changed"}}`)
	if got := observe("done"); got.CompletionID != first.CompletionID {
		t.Fatal("metadata changed completion ID")
	}
	appendEvent(`{"type":"event_msg","payload":{"type":"task_started","turn_id":"two"}}`)
	if got := observe("done"); got.CompletionID != "" || got.AgentStatus != "working" {
		t.Fatal("stale runtime done exposed a completion for a running turn")
	}
	appendEvent(`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"two"}}`)
	second := observe("done")
	if second.CompletionID == first.CompletionID || second.CompletionID == "" {
		t.Fatal("fast new turn did not change completion ID")
	}
	if !observedPaneChanged(monitoredPane{pane: first}, monitoredPane{pane: second}) {
		t.Fatal("new completion alone did not wake snapshot readers")
	}
	pane.AgentInstanceID = "replacement"
	if got := observe("done"); got.CompletionID == second.CompletionID {
		t.Fatal("replacement shared completion ID")
	}
	pane.AgentSession = nil
	if got := observe("done"); got.CompletionID != "" {
		t.Fatal("missing transcript invented completion ID")
	}
	raw, err := json.Marshal(second)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["completion_id"] != second.CompletionID || wire["TaskEvidence"] != nil || wire["AgentSession"] != nil {
		t.Fatal("completion wire leaked internal evidence or lost the opaque ID")
	}
}
