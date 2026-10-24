package daemon

import (
	"context"
	"time"

	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

// codexDialogLines is the live bottom of a Codex pane. The plan picker and
// other choice lists sit there; older scrollback is not part of the decision.
const codexDialogLines = 40

// decorateAgentActivity applies the same task semantics to phone snapshots and
// notification observations. It does not change the raw runtime used for path
// authorization or commands, and never takes a transcript path from a client.
func (e *Engine) decorateAgentActivity(ctx context.Context, session runtime.SessionRef, snapshot runtime.Snapshot) runtime.Snapshot {
	snapshot.Panes = append([]runtime.Pane(nil), snapshot.Panes...)
	for i := range snapshot.Panes {
		pane := &snapshot.Panes[i]
		e.decorateAgentTitle(pane)
		pane.TaskEvidence = ""
		pane.Activity = nil
		if pane.Agent == "" || pane.AgentStatus == "unknown" {
			continue
		}
		reported := pane.AgentStatus
		if reported != "blocked" {
			e.decorateTaskStatus(pane)
		}
		// Herdr's screen rules miss some Codex choice lists and report idle or
		// done. Lift only those. A status Herdr already calls blocked is left
		// alone, and a failed read keeps the reported status.
		if pane.Agent == "codex" && (reported == "idle" || reported == "done") &&
			(pane.AgentStatus == "idle" || pane.AgentStatus == "done") {
			e.promoteCodexChoice(ctx, session, pane)
		}
		e.decorateTurnActivity(pane)
	}
	return snapshot
}

func (e *Engine) promoteCodexChoice(ctx context.Context, session runtime.SessionRef, pane *runtime.Pane) {
	if e == nil || e.RT == nil || pane.PaneID == "" {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	readCtx, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	defer cancel()
	view, err := e.RT.Observe(readCtx, session, runtime.PaneReadQuery{
		PaneID: pane.PaneID, Source: runtime.SourceRecent, Format: runtime.FormatText, Lines: codexDialogLines,
	})
	if err != nil {
		return
	}
	read, ok := view.(runtime.PaneReadView)
	if !ok || !codexChoiceDialog(read.Text) {
		return
	}
	pane.AgentStatus = "blocked"
}

func (e *Engine) decorateTaskStatus(pane *runtime.Pane) {
	activity := journal.Activity{}
	if e.Journal != nil && pane.AgentSession != nil {
		activity = e.Journal.ReadActivity(journalRef(pane.AgentSession))
	}
	pane.TaskEvidence = activity.Key
	if pane.LaunchPending != nil && *pane.LaunchPending {
		pane.AgentStatus = "idle"
		return
	}
	if pane.AgentStatus == "done" && activity.State == "working" {
		pane.AgentStatus = "working"
	}
	// Missing bindings, a rotating file or an incomplete bounded tail are
	// unknown, not evidence of an empty startup. Preserve the runtime state.
	if (pane.AgentStatus == "done" || pane.AgentStatus == "working") && activity.Known && activity.Key == "" {
		pane.AgentStatus = "idle"
	}
}

// decorateTurnActivity adds the step a list row shows (proto/agent-activity.md)
// for a pane whose agent is working, waiting on the reader or just finished.
func (e *Engine) decorateTurnActivity(pane *runtime.Pane) {
	if e.Journal == nil || pane.AgentSession == nil {
		return
	}
	var mode journal.TurnActivityMode
	switch pane.AgentStatus {
	case "working":
		mode = journal.TurnWorking
	case "blocked":
		mode = journal.TurnBlocked
	case "done":
		mode = journal.TurnDone
	default:
		return
	}
	activity, ok := e.Journal.ReadTurnActivity(journalRef(pane.AgentSession), mode)
	if !ok {
		return
	}
	pane.Activity = &runtime.PaneActivity{
		Type: activity.Type, Name: activity.Name, Label: activity.Label, State: activity.State, At: activity.At,
	}
	if turn := activity.Turn; turn != nil {
		pane.Activity.Turn = &runtime.PaneTurn{
			Steps: turn.Steps, Files: turn.Files, Plan: turn.Plan, Failed: turn.Failed, Interrupted: turn.Interrupted,
		}
	}
}

// observedActivity is what a list row shows of a pane's activity, as a
// comparable value. A newer record time alone is no change worth a poke: the
// step it stamps is the same. The monitor's poll interval bounds how often an
// activity change pokes.
func observedActivity(activity *runtime.PaneActivity) activityObservation {
	if activity == nil {
		return activityObservation{}
	}
	observed := activityObservation{present: true, kind: activity.Type, name: activity.Name, label: activity.Label, state: activity.State}
	if activity.Turn != nil {
		observed.turn = *activity.Turn
		observed.ended = true
	}
	return observed
}

type activityObservation struct {
	present, ended           bool
	kind, name, label, state string
	turn                     runtime.PaneTurn
}

// monitorRefreshEvery is how long an event-driven monitor waits before its
// next authoritative snapshot. A row's step changes in the agent's transcript
// with no runtime event to announce it, so while a connected phone may be
// showing an agent mid-turn the monitor reconciles at the polling rate;
// otherwise the runtime's events carry it between slower snapshots.
func (e *Engine) monitorRefreshEvery(state *sessionMonitorState, every, healthy time.Duration) time.Duration {
	if !e.hasEstablishedSession() {
		return healthy
	}
	for _, pane := range state.panes {
		if pane.pane.Activity != nil && (pane.status == "working" || pane.status == "blocked") {
			return every
		}
	}
	return healthy
}

func (e *Engine) hasEstablishedSession() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.sessions {
		if s.state == "established" {
			return true
		}
	}
	return false
}
