package daemon

import (
	"context"
	"strconv"
	"sync"
	"time"

	"pairfob/internal/runtime"
)

// observeGroup collapses overlapping Snapshot / PaneRead Observe calls for the
// same named session (and pane_id) into one Herdr round-trip. Waiters each
// AEAD-seal their own FWD; the relay still never parses payload. Completed
// results are not cached — a later call always hits the runtime again.
type observeGroup struct {
	mu       sync.Mutex
	inflight map[string]*observeFlight
}

type observeFlight struct {
	done    chan struct{}
	waiters int
	started time.Time
	view    runtime.View
	err     error
}

func observeKey(session *string, query runtime.Query) (string, bool) {
	name := ""
	if session != nil {
		name = *session
	}
	switch q := query.(type) {
	case runtime.SnapshotQuery:
		return "S\x00" + name, true
	case runtime.PaneReadQuery:
		return "P\x00" + name + "\x00" + q.PaneID + "\x00" + q.Source + "\x00" + q.Format + "\x00" + strconv.Itoa(q.Lines), true
	default:
		return "", false
	}
}

func (g *observeGroup) do(key string, fn func() (runtime.View, error)) (runtime.View, error) {
	return g.doContext(context.Background(), key, fn)
}

// Cancelling a waiter never cancels the shared, bounded read for other callers.
func (g *observeGroup) doContext(ctx context.Context, key string, fn func() (runtime.View, error)) (runtime.View, error) {
	return g.doAfter(ctx, key, time.Time{}, fn)
}

func (g *observeGroup) doAfter(ctx context.Context, key string, notBefore time.Time, fn func() (runtime.View, error)) (runtime.View, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if g.inflight == nil {
		g.inflight = map[string]*observeFlight{}
	}
	flight := g.inflight[key]
	if flight != nil && flight.started.Before(notBefore) {
		// A post-event monitor starts fresh immediately; old waiters finish on
		// their own flight, while later phone reads may join this newer one.
		flight = nil
	}
	if flight != nil {
		flight.waiters++
	} else {
		flight = &observeFlight{done: make(chan struct{}), waiters: 1, started: time.Now()}
		g.inflight[key] = flight
		go func() {
			flight.view, flight.err = fn()
			g.mu.Lock()
			if g.inflight[key] == flight {
				delete(g.inflight, key)
			}
			close(flight.done)
			g.mu.Unlock()
		}()
	}
	g.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-flight.done:
		return flight.view, flight.err
	}
}

func (g *observeGroup) waiterCount(key string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if flight := g.inflight[key]; flight != nil {
		return flight.waiters
	}
	return 0
}

func (e *Engine) observe(session *string, query runtime.Query) (runtime.View, error) {
	e.touchRuntimeSession(runtimeSession(session))
	return e.observeContext(context.Background(), session, query)
}

func (e *Engine) observeContext(waitCtx context.Context, session *string, query runtime.Query) (runtime.View, error) {
	return e.observeAfter(waitCtx, session, query, time.Time{})
}

func (e *Engine) observeAfter(waitCtx context.Context, session *string, query runtime.Query, notBefore time.Time) (runtime.View, error) {
	run := func() (runtime.View, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		view, err := e.RT.Observe(ctx, runtimeSession(session), query)
		if err != nil {
			return nil, err
		}
		return e.markHistory(view), nil
	}
	if key, ok := observeKey(session, query); ok {
		return e.reads.doAfter(waitCtx, key, notBefore, run)
	}
	return run()
}

func (e *Engine) markHistory(view runtime.View) runtime.View {
	snap, ok := view.(runtime.SnapshotView)
	if !ok {
		return view
	}
	snap.Snapshot = e.decorateAgentActivity(snap.Snapshot)
	for i := range snap.Snapshot.Panes {
		pane := &snap.Snapshot.Panes[i]
		pane.HistoryAvailable = pane.AgentSession != nil && e.Journal != nil && e.Journal.Available(journalRef(pane.AgentSession))
	}
	return snap
}
