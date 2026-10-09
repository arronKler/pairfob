package daemon

import (
	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

// decorateAgentActivity applies the same task semantics to phone snapshots and
// notification observations. It does not change the raw runtime used for path
// authorization or commands, and never takes a transcript path from a client.
func (e *Engine) decorateAgentActivity(snapshot runtime.Snapshot) runtime.Snapshot {
	snapshot.Panes = append([]runtime.Pane(nil), snapshot.Panes...)
	for i := range snapshot.Panes {
		pane := &snapshot.Panes[i]
		e.decorateAgentTitle(pane)
		pane.TaskEvidence = ""
		if pane.Agent == "" || pane.AgentStatus == "blocked" || pane.AgentStatus == "unknown" {
			continue
		}
		activity := journal.Activity{}
		if e.Journal != nil && pane.AgentSession != nil {
			activity = e.Journal.ReadActivity(journalRef(pane.AgentSession))
		}
		pane.TaskEvidence = activity.Key
		if pane.LaunchPending != nil && *pane.LaunchPending {
			pane.AgentStatus = "idle"
			continue
		}
		if pane.AgentStatus == "done" && activity.State == "working" {
			pane.AgentStatus = "working"
		}
		if pane.AgentStatus == "done" && activity.Key == "" ||
			pane.AgentStatus == "working" && activity.Known && activity.Key == "" {
			pane.AgentStatus = "idle"
		}
	}
	return snapshot
}
