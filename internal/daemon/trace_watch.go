package daemon

import (
	"os"
	"sync"
	"time"

	"pairfob/internal/journal"
)

const (
	traceWatchTTL  = 30 * time.Second
	traceWatchTick = 500 * time.Millisecond
)

// traceKey is what a change of the journal looks like from outside: its path,
// size and modification time.
type traceKey struct {
	path  string
	size  int64
	mtime time.Time
}

type traceWatchState struct {
	mu      sync.Mutex
	running bool
	keys    map[string]traceKey // by pane_id

	// Test seams; nil means the real clock, file system and journal lookup.
	now     func() time.Time
	stat    func(string) (os.FileInfo, error)
	resolve func(journal.Ref) (string, error)
}

func (e *Engine) traceNow() time.Time {
	if e.traceWatch.now != nil {
		return e.traceWatch.now()
	}
	return time.Now()
}

// watchTrace remembers the conversation s just read and refreshes its TTL. The
// first read starts the watch loop; it stops again when nothing is watched.
func (e *Engine) watchTrace(s *sess, paneID string, ref journal.Ref) {
	s.watchMu.Lock()
	s.watchPane, s.watchRef, s.watchUntil = paneID, ref, e.traceNow().Add(traceWatchTTL)
	s.watchMu.Unlock()
	e.traceWatch.mu.Lock()
	start := !e.traceWatch.running
	e.traceWatch.running = true
	e.traceWatch.mu.Unlock()
	if start {
		go e.runTraceWatch()
	}
}

func (e *Engine) runTraceWatch() {
	ticker := time.NewTicker(traceWatchTick)
	defer ticker.Stop()
	for range ticker.C {
		if e.traceWatchTick() > 0 {
			continue
		}
		e.traceWatch.mu.Lock()
		if len(e.watchedSessions()) == 0 {
			e.traceWatch.running = false
			e.traceWatch.keys = nil
			e.traceWatch.mu.Unlock()
			return
		}
		e.traceWatch.mu.Unlock()
	}
}

type traceWatcher struct {
	ref      journal.Ref
	sessions map[*sess]bool
}

// watchedSessions groups the sessions with a live TTL by the pane they read.
func (e *Engine) watchedSessions() map[string]*traceWatcher {
	now := e.traceNow()
	watched := map[string]*traceWatcher{}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.sessions {
		if s.state != "established" {
			continue
		}
		s.watchMu.Lock()
		pane, ref, until := s.watchPane, s.watchRef, s.watchUntil
		s.watchMu.Unlock()
		if pane == "" || !now.Before(until) {
			continue
		}
		w := watched[pane]
		if w == nil {
			w = &traceWatcher{ref: ref, sessions: map[*sess]bool{}}
			watched[pane] = w
		}
		w.sessions[s] = true
	}
	return watched
}

// traceWatchTick stats the journal of each watched pane once and pokes the
// sessions watching a pane whose journal changed since the last tick. A pane
// seen for the first time only records its key. It returns the number of
// watched panes.
func (e *Engine) traceWatchTick() int {
	watched := e.watchedSessions()
	e.traceWatch.mu.Lock()
	if e.traceWatch.keys == nil {
		e.traceWatch.keys = map[string]traceKey{}
	}
	keys := e.traceWatch.keys
	for pane := range keys {
		if watched[pane] == nil {
			delete(keys, pane)
		}
	}
	e.traceWatch.mu.Unlock()
	for pane, w := range watched {
		key, ok := e.traceKeyOf(w.ref)
		e.traceWatch.mu.Lock()
		old, seen := keys[pane]
		if ok {
			keys[pane] = key
		} else {
			delete(keys, pane)
		}
		e.traceWatch.mu.Unlock()
		if ok && seen && key != old {
			e.pokeSessions("agent_trace", pane, w.sessions)
		}
	}
	return len(watched)
}

func (e *Engine) traceKeyOf(ref journal.Ref) (traceKey, bool) {
	if e.Journal == nil {
		return traceKey{}, false
	}
	resolve := e.traceWatch.resolve
	if resolve == nil {
		resolve = e.Journal.TranscriptPath
	}
	path, err := resolve(ref)
	if err != nil {
		return traceKey{}, false
	}
	stat := e.traceWatch.stat
	if stat == nil {
		stat = os.Stat
	}
	info, err := stat(path)
	if err != nil {
		return traceKey{}, false
	}
	return traceKey{path: path, size: info.Size(), mtime: info.ModTime()}, true
}
