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
	g.mu.Lock()
	if g.inflight == nil {
		g.inflight = map[string]*observeFlight{}
	}
	if flight := g.inflight[key]; flight != nil {
		flight.waiters++
		g.mu.Unlock()
		<-flight.done
		return flight.view, flight.err
	}
	flight := &observeFlight{done: make(chan struct{}), waiters: 1}
	g.inflight[key] = flight
	g.mu.Unlock()

	flight.view, flight.err = fn()

	g.mu.Lock()
	delete(g.inflight, key)
	g.mu.Unlock()
	close(flight.done)
	return flight.view, flight.err
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
		return e.reads.do(key, run)
	}
	return run()
}

func (e *Engine) markHistory(view runtime.View) runtime.View {
	snap, ok := view.(runtime.SnapshotView)
	if !ok {
		return view
	}
	for i := range snap.Snapshot.Panes {
		pane := &snap.Snapshot.Panes[i]
		pane.HistoryAvailable = pane.AgentSession != nil && e.Journal != nil && e.Journal.Available(journalRef(pane.AgentSession))
	}
	return snap
}
