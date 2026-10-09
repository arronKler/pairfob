package daemon

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"pairfob/internal/runtime"
)

const (
	maxNamedRuntimeMonitors = 16
	namedMonitorLifetime    = 2 * time.Minute
	monitorEventDrainLimit  = 64
)

type runtimeMonitorLease struct {
	cancel      context.CancelFunc
	lastTouched time.Time
}

type monitoredPane struct {
	status             string
	instanceID         string
	stateChangeSeq     *uint64
	interactiveReady   *bool
	launchPending      *bool
	completionEvidence string
	workspaceLabel     string
	tabLabel           string
	pane               runtime.Pane
}

type sessionMonitorState struct {
	panes        map[string]monitoredPane
	availability runtimeAvailability
}

func (e *Engine) touchRuntimeSession(session runtime.SessionRef) {
	if session.Name == "" {
		return
	}
	now := time.Now()
	e.runtimeMonitorMu.Lock()
	if len(e.runtimeMonitorTouches) >= maxNamedRuntimeMonitors*2 {
		oldestName := ""
		var oldest time.Time
		for name, touched := range e.runtimeMonitorTouches {
			if oldestName == "" || touched.Before(oldest) {
				oldestName, oldest = name, touched
			}
		}
		delete(e.runtimeMonitorTouches, oldestName)
	}
	e.runtimeMonitorTouches[session.Name] = now
	e.runtimeMonitorMu.Unlock()
	select {
	case e.runtimeMonitorWake <- struct{}{}:
	default:
	}
}

func (e *Engine) takeRuntimeTouches() map[string]time.Time {
	e.runtimeMonitorMu.Lock()
	defer e.runtimeMonitorMu.Unlock()
	out := e.runtimeMonitorTouches
	e.runtimeMonitorTouches = map[string]time.Time{}
	return out
}

func (e *Engine) runRuntimeMonitors(stop <-chan struct{}, every time.Duration) {
	if every <= 0 {
		every = 2 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if stop != nil {
		go func() {
			select {
			case <-stop:
				cancel()
			case <-ctx.Done():
			}
		}()
	}

	type pokeEvent struct{ reason, paneID string }
	pokes := make(chan pokeEvent, 64)
	notifications := make(chan HerdPush, 64)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for {
			select {
			case event := <-pokes:
				e.sendPoke(event.reason, event.paneID)
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for {
			select {
			case event := <-notifications:
				deliveryCtx, deliveryCancel := context.WithTimeout(ctx, 20*time.Second)
				_ = e.notifyHerd(deliveryCtx, event)
				deliveryCancel()
			case <-ctx.Done():
				return
			}
		}
	}()
	emitPoke := func(reason, paneID string) {
		select {
		case pokes <- pokeEvent{reason: reason, paneID: paneID}:
		default:
			// A Poke only accelerates an authoritative client snapshot.
		}
	}
	emitPush := func(event HerdPush) {
		select {
		case notifications <- event:
		default:
			// Push is best effort. Keep observation bounded; foreground clients
			// still converge through Pokes and snapshot polling.
		}
	}

	workers.Add(1)
	go func() {
		defer workers.Done()
		e.runSessionMonitor(ctx, runtime.DefaultSession(), every, true, emitPoke, emitPush)
	}()

	leases := map[string]runtimeMonitorLease{}
	cleanupEvery := namedMonitorLifetime / 4
	cleanup := time.NewTicker(cleanupEvery)
	defer cleanup.Stop()
	defer func() {
		for _, lease := range leases {
			lease.cancel()
		}
		cancel()
		workers.Wait()
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-e.runtimeMonitorWake:
			touches := e.takeRuntimeTouches()
			for name, touched := range touches {
				if lease, ok := leases[name]; ok {
					lease.lastTouched = touched
					leases[name] = lease
					continue
				}
				if len(leases) >= maxNamedRuntimeMonitors {
					oldestName := ""
					var oldest time.Time
					for candidate, current := range leases {
						if oldestName == "" || current.lastTouched.Before(oldest) {
							oldestName, oldest = candidate, current.lastTouched
						}
					}
					leases[oldestName].cancel()
					delete(leases, oldestName)
				}
				monitorCtx, monitorCancel := context.WithCancel(ctx)
				leases[name] = runtimeMonitorLease{cancel: monitorCancel, lastTouched: touched}
				workers.Add(1)
				go func(name string) {
					defer workers.Done()
					e.runSessionMonitor(monitorCtx, runtime.NamedSession(name), every, false, emitPoke, emitPush)
				}(name)
			}
		case now := <-cleanup.C:
			for name, lease := range leases {
				if now.Sub(lease.lastTouched) >= namedMonitorLifetime {
					lease.cancel()
					delete(leases, name)
				}
			}
		}
	}
}

func (e *Engine) runSessionMonitor(ctx context.Context, session runtime.SessionRef, every time.Duration, allowPush bool, emitPoke func(string, string), emitPush func(HerdPush)) {
	state := sessionMonitorState{panes: map[string]monitoredPane{}, availability: runtimeUnknown}
	subscriber, supportsEvents := e.RT.(runtime.EventSubscriber)
	membership := []string(nil)
	for ctx.Err() == nil {
		if !supportsEvents || len(membership) > 1024 {
			e.pollRuntimeSession(ctx, session, every, allowPush, &state, emitPoke, emitPush)
			return
		}
		stream, err := subscriber.SubscribeEvents(ctx, session, runtime.EventSubscription{PaneIDs: membership})
		if err != nil {
			if fault, ok := runtime.AsFault(err); ok && fault.Code == runtime.CodeUnsupported {
				supportsEvents = false
				continue
			}
			e.reconcileRuntimeSession(ctx, session, allowPush, &state, emitPoke, emitPush)
			if !waitRuntimeMonitor(ctx, every) {
				return
			}
			continue
		}

		// The stream is installed before this authoritative reconciliation, so
		// transitions during Snapshot remain queued rather than disappearing.
		changedMembership, nextMembership := e.reconcileRuntimeSession(ctx, session, allowPush, &state, emitPoke, emitPush)
		if changedMembership || !sameStrings(membership, nextMembership) {
			membership = nextMembership
			_ = stream.Close()
			continue
		}
		healthyEvery := every * 5
		if healthyEvery < every {
			healthyEvery = every
		}
		timer := time.NewTimer(healthyEvery)
		reconnect, streamFailed := false, false
		for !reconnect {
			select {
			case <-ctx.Done():
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				_ = stream.Close()
				return
			case event, ok := <-stream.Events():
				if !ok {
					reconnect, streamFailed = true, true
					break
				}
				e.applyRuntimeEvent(event, emitPoke)
				// Drain a bounded batch of queued invalidations before taking
				// the authoritative snapshot that resolves all of them.
			Drain:
				for drained := 0; drained < monitorEventDrainLimit; drained++ {
					select {
					case queued, open := <-stream.Events():
						if !open {
							reconnect, streamFailed = true, true
							break Drain
						}
						e.applyRuntimeEvent(queued, emitPoke)
					default:
						break Drain
					}
				}
				changed, panes := e.reconcileRuntimeSession(ctx, session, allowPush, &state, emitPoke, emitPush)
				if changed || !sameStrings(membership, panes) {
					membership, reconnect = panes, true
				}
			case <-timer.C:
				changed, panes := e.reconcileRuntimeSession(ctx, session, allowPush, &state, emitPoke, emitPush)
				membership = panes
				reconnect = changed
				timer.Reset(healthyEvery)
			}
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		_ = stream.Close()
		if streamFailed && !waitRuntimeMonitor(ctx, every) {
			return
		}
	}
}

func (e *Engine) pollRuntimeSession(ctx context.Context, session runtime.SessionRef, every time.Duration, allowPush bool, state *sessionMonitorState, emitPoke func(string, string), emitPush func(HerdPush)) {
	for {
		e.reconcileRuntimeSession(ctx, session, allowPush, state, emitPoke, emitPush)
		if !waitRuntimeMonitor(ctx, every) {
			return
		}
	}
}

func waitRuntimeMonitor(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (e *Engine) monitorSnapshot(ctx context.Context, session runtime.SessionRef) (runtime.Snapshot, error) {
	callCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	view, err := e.RT.Observe(callCtx, session, runtime.SnapshotQuery{})
	if err != nil {
		return runtime.Snapshot{}, err
	}
	snapshot, ok := view.(runtime.SnapshotView)
	if !ok {
		return runtime.Snapshot{}, errors.New("runtime returned an invalid snapshot view")
	}
	return e.decorateAgentActivity(snapshot.Snapshot), nil
}

func (e *Engine) reconcileRuntimeSession(ctx context.Context, session runtime.SessionRef, allowPush bool, state *sessionMonitorState, emitPoke func(string, string), emitPush func(HerdPush)) (bool, []string) {
	snapshot, err := e.monitorSnapshot(ctx, session)
	nextAvailability, reason := transitionRuntimeAvailability(state.availability, err == nil)
	state.availability = nextAvailability
	if reason != "" && session.Name == "" {
		emitPoke(reason, "")
	}
	if err != nil {
		return false, paneMembership(state.panes)
	}
	labels := make(map[string]string, len(snapshot.Workspaces))
	for _, workspace := range snapshot.Workspaces {
		labels[workspace.WorkspaceID] = workspace.Label
	}
	tabLabels := make(map[string]string, len(snapshot.Tabs))
	for _, tab := range snapshot.Tabs {
		tabLabels[tab.TabID] = tab.Label
	}
	next := make(map[string]monitoredPane, len(snapshot.Panes))
	for _, pane := range snapshot.Panes {
		previous, known := state.panes[pane.PaneID]
		current := monitoredPane{
			status: pane.AgentStatus, instanceID: pane.AgentInstanceID,
			stateChangeSeq: copyUint64(pane.StateChangeSeq), interactiveReady: copyBool(pane.InteractiveReady),
			launchPending: copyBool(pane.LaunchPending), workspaceLabel: labels[pane.WorkspaceID],
			tabLabel: tabLabels[pane.TabID], pane: pane,
		}
		sameOccupant := known && (previous.instanceID == "" || pane.AgentInstanceID == "" || previous.instanceID == pane.AgentInstanceID)
		if !known || !sameOccupant || observedPaneChanged(previous, current) {
			emitPoke("agent_status", pane.PaneID)
		}
		if sameOccupant {
			current.completionEvidence = previous.completionEvidence
			sequenceAdvanced := pane.StateChangeSeq != nil && previous.stateChangeSeq != nil && *pane.StateChangeSeq > *previous.stateChangeSeq
			kind, notify := pushKindForObservation(previous.status, pane.AgentStatus, sequenceAdvanced)
			if kind == PushDone && (pane.TaskEvidence == "" || pane.TaskEvidence == previous.completionEvidence) {
				notify = false
			}
			if notify && allowPush && e.PushEnabled {
				emitPush(herdPushForPane(pane, current.workspaceLabel, current.tabLabel, kind))
			}
		}
		if pane.AgentStatus == "done" || !sameOccupant || (pane.LaunchPending != nil && *pane.LaunchPending) {
			current.completionEvidence = pane.TaskEvidence
		}
		next[pane.PaneID] = current
	}
	previousMembership := paneMembership(state.panes)
	nextMembership := paneMembership(next)
	state.panes = next
	return !sameStrings(previousMembership, nextMembership), nextMembership
}

func (e *Engine) applyRuntimeEvent(event runtime.Event, emitPoke func(string, string)) {
	// Protocol 20 events carry neither occupant identity nor a sequence. Treat
	// every validated event as an invalidation only; the following authoritative
	// snapshot decides status and notification semantics.
	emitPoke("agent_status", event.PaneID)
}

func pushKindForObservation(previous, current string, sequenceAdvanced bool) (PushKind, bool) {
	kind, notify := pushKindForTransition(previous, true, current)
	if current == "done" && sequenceAdvanced {
		return PushDone, true
	}
	return kind, notify
}

func herdPushForPane(pane runtime.Pane, workspaceLabel, tabLabel string, kind PushKind) HerdPush {
	return HerdPush{
		HerdID: pane.PaneID, Agent: pane.Agent, WorkspaceLabel: workspaceLabel, Cwd: pane.Cwd,
		PaneLabel: optionalText(pane.Label), TerminalTitle: pane.TerminalTitle, TabLabel: tabLabel,
		Kind: kind, AgentInstanceID: pane.AgentInstanceID, StateChangeSeq: copyUint64(pane.StateChangeSeq),
		TaskEvidence: pane.TaskEvidence,
	}
}

func observedPaneChanged(previous, current monitoredPane) bool {
	return previous.status != current.status || previous.instanceID != current.instanceID ||
		observedTaskTitle(previous.pane) != observedTaskTitle(current.pane) ||
		!equalUint64(previous.stateChangeSeq, current.stateChangeSeq) ||
		!equalBool(previous.interactiveReady, current.interactiveReady) ||
		!equalBool(previous.launchPending, current.launchPending)
}

func paneMembership(panes map[string]monitoredPane) []string {
	ids := make([]string, 0, len(panes))
	for paneID := range panes {
		ids = append(ids, paneID)
	}
	sort.Strings(ids)
	return ids
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func copyUint64(value *uint64) *uint64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyBool(value *bool) *bool {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func equalUint64(a, b *uint64) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func equalBool(a, b *bool) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
