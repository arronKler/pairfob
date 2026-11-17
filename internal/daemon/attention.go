package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"time"

	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

// The ledger is the authority for a pane that needs the reader. It survives
// daemon restarts and upgrades, so a blocked pane is told once per device and
// keeps a bounded escalation while it stays unanswered.
// The delivery and retraction bounds are mirrored by validateAttention in
// internal/state/attention.go; change both together.
const (
	attentionMaxDeliveries    = 3
	attentionRetryFirst       = 5 * time.Minute
	attentionRetryNext        = 15 * time.Minute
	attentionRetractAttempts  = 3
	attentionRetractBackoff   = time.Minute
	attentionRetractRetention = 24 * time.Hour
)

func attentionSeconds(duration time.Duration) int64 { return int64(duration / time.Second) }

func newAttentionID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return "att_" + hex.EncodeToString(raw[:])
}

func (e *Engine) restoreAttention(rows []state.AttentionEvent) {
	e.attention = make(map[string]*state.AttentionEvent, len(rows))
	for _, row := range rows {
		event := row
		if event.Deliveries == nil {
			event.Deliveries = map[string]state.AttentionDelivery{}
		}
		e.attention[event.ID] = &event
	}
}

// saveAttentionLocked persists the ledger. The caller holds e.mu.
func (e *Engine) saveAttentionLocked() error {
	if e.Store == nil {
		return nil
	}
	rows := make([]state.AttentionEvent, 0, len(e.attention))
	for _, event := range e.attention {
		rows = append(rows, *event)
	}
	return e.Store.SaveAttention(rows)
}

// attentionSameOccupant treats a missing runtime identity as compatible, the
// same way the monitor's sameOccupant gate does. A real replacement resolves
// the old episode and starts a new one.
func attentionSameOccupant(event *state.AttentionEvent, pane runtime.Pane) bool {
	if event.TerminalID != "" && pane.TerminalID != "" && event.TerminalID != pane.TerminalID {
		return false
	}
	if event.InstanceID != "" && pane.AgentInstanceID != "" && event.InstanceID != pane.AgentInstanceID {
		return false
	}
	return true
}

func attentionRetryInterval(delivered int) time.Duration {
	if delivered <= 1 {
		return attentionRetryFirst
	}
	return attentionRetryNext
}

// reconcileAttention runs after every authoritative default-session snapshot.
// It resolves episodes that ended, creates episodes for newly blocked panes,
// and schedules only the deliveries that are due for a subscribed device.
func (e *Engine) reconcileAttention(session runtime.SessionRef, snapshot runtime.Snapshot, emitPush func(HerdPush)) {
	if e == nil || !e.PushEnabled {
		return
	}
	observedAt := time.Now()
	now := observedAt.Unix()
	workspaces := make(map[string]string, len(snapshot.Workspaces))
	for _, workspace := range snapshot.Workspaces {
		workspaces[workspace.WorkspaceID] = workspace.Label
	}
	tabs := make(map[string]string, len(snapshot.Tabs))
	for _, tab := range snapshot.Tabs {
		tabs[tab.TabID] = tab.Label
	}
	current := make(map[string]runtime.Pane, len(snapshot.Panes))
	for _, pane := range snapshot.Panes {
		current[pane.PaneID] = pane
	}

	var pushes []HerdPush
	var retracts []HerdPush
	changed := false
	e.mu.Lock()
	if e.attention == nil {
		e.attention = map[string]*state.AttentionEvent{}
	}
	open := make(map[string]*state.AttentionEvent)

	for _, event := range e.attention {
		if event.Session != session.Name || event.ResolvedAt != 0 {
			continue
		}
		pane, present := current[event.PaneID]
		if !present {
			event.ResolvedAt = now
			changed = true
			continue
		}
		if pane.AgentStatus == "" || pane.AgentStatus == "unknown" {
			// Missing information neither ends an episode nor starts one.
			continue
		}
		if pane.AgentStatus != "blocked" || !attentionSameOccupant(event, pane) {
			event.ResolvedAt = now
			changed = true
			continue
		}
		if event.TerminalID == "" && pane.TerminalID != "" {
			event.TerminalID = pane.TerminalID
			changed = true
		}
		if event.InstanceID == "" && pane.AgentInstanceID != "" {
			event.InstanceID = pane.AgentInstanceID
			changed = true
		}
		open[pane.PaneID] = event
	}

	for _, pane := range snapshot.Panes {
		if pane.AgentStatus != "blocked" || open[pane.PaneID] != nil {
			continue
		}
		event := &state.AttentionEvent{
			ID: newAttentionID(), Session: session.Name, PaneID: pane.PaneID,
			TerminalID: pane.TerminalID, InstanceID: pane.AgentInstanceID,
			CreatedAt: now, CreatedAtNS: observedAt.UnixNano(), Deliveries: map[string]state.AttentionDelivery{},
		}
		e.attention[event.ID] = event
		open[pane.PaneID] = event
		changed = true
	}

	for paneID, event := range open {
		pane := current[paneID]
		due := make([]string, 0, len(e.Devices))
		for deviceID, device := range e.Devices {
			if device == nil || device.RevokedAt != nil || len(device.PushSubscriptions) == 0 {
				continue
			}
			delivery := event.Deliveries[deviceID]
			switch {
			case delivery.Count == 0:
				due = append(due, deviceID)
			case delivery.Count < attentionMaxDeliveries &&
				now-delivery.LastAt >= attentionSeconds(attentionRetryInterval(delivery.Count)):
				due = append(due, deviceID)
			}
		}
		if len(due) == 0 {
			continue
		}
		sort.Strings(due)
		for _, deviceID := range due {
			delivery := event.Deliveries[deviceID]
			delivery.Count++
			delivery.LastAt = now
			event.Deliveries[deviceID] = delivery
		}
		push := herdPushForPane(pane, workspaces[pane.WorkspaceID], tabs[pane.TabID], PushNeedsYou)
		push.Devices = due
		push.AttentionID = event.ID
		push.AttentionAt = attentionCreatedAtNS(event)
		pushes = append(pushes, push)
		changed = true
	}

	for id, event := range e.attention {
		if event.Session != session.Name || event.ResolvedAt == 0 {
			continue
		}
		due := make([]string, 0, len(event.Deliveries))
		for deviceID, delivery := range event.Deliveries {
			device := e.Devices[deviceID]
			unreachable := device == nil || device.RevokedAt != nil || len(device.PushSubscriptions) == 0
			switch {
			case unreachable, delivery.RetractedAt != 0, delivery.Count == 0:
				delete(event.Deliveries, deviceID)
				changed = true
			case delivery.RetractCount >= attentionRetractAttempts:
				delete(event.Deliveries, deviceID)
				changed = true
			case delivery.RetractCount == 0 ||
				now-delivery.RetractAt >= attentionSeconds(attentionRetractBackoff):
				due = append(due, deviceID)
				delivery.RetractCount++
				delivery.RetractAt = now
				event.Deliveries[deviceID] = delivery
				changed = true
			}
		}
		if len(due) > 0 {
			sort.Strings(due)
			retracts = append(retracts, HerdPush{
				HerdID: event.PaneID, Kind: PushRetract, Devices: due,
				AttentionID: event.ID, AttentionAt: attentionCreatedAtNS(event),
			})
		}
		if len(event.Deliveries) == 0 ||
			now-event.ResolvedAt >= attentionSeconds(attentionRetractRetention) {
			delete(e.attention, id)
			changed = true
		}
	}

	if changed {
		_ = e.saveAttentionLocked()
	}
	e.mu.Unlock()
	// Resolutions lead so a new episode's notice replaces the old episode's
	// quiet update when they reuse the same pane tag.
	for _, push := range retracts {
		emitPush(push)
	}
	for _, push := range pushes {
		emitPush(push)
	}
}

func attentionCreatedAtNS(event *state.AttentionEvent) int64 {
	if event.CreatedAtNS != 0 {
		return event.CreatedAtNS
	}
	return event.CreatedAt * int64(time.Second)
}

// attentionRetracted records that the push service accepted a retraction for
// these devices. A rejected delivery keeps the record, so the next reconcile
// retries it until the attempt budget is spent.
func (e *Engine) attentionRetracted(push HerdPush) {
	if e == nil || push.Kind != PushRetract || push.AttentionID == "" {
		return
	}
	now := time.Now().Unix()
	e.mu.Lock()
	event := e.attention[push.AttentionID]
	if event == nil {
		e.mu.Unlock()
		return
	}
	changed := false
	for _, deviceID := range push.Devices {
		delivery, ok := event.Deliveries[deviceID]
		if !ok || delivery.RetractedAt != 0 {
			continue
		}
		delivery.RetractedAt = now
		event.Deliveries[deviceID] = delivery
		changed = true
	}
	if changed {
		_ = e.saveAttentionLocked()
	}
	e.mu.Unlock()
}
