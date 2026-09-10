package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"time"

	"pairfob/internal/workspace"
)

const (
	maxMediaHandlesSession = 4
	maxMediaHandlesGlobal  = 16
	mediaHandleIdle        = 120 * time.Second
	mediaHandleTTL         = 10 * time.Minute
	mediaHandlePattern     = `^media_[0-9a-f]{32}$`
)

var mediaRPCSlots = make(chan struct{}, 2)

type mediaHandle struct {
	id         string
	session    *sess
	rpcSession *string
	route      [16]byte
	paneID     string
	root       string
	relPath    string
	file       *workspace.MediaFile
	opened     time.Time
	deadline   time.Time
	timer      *time.Timer
	reading    atomic.Bool
}

type mediaRegistry struct {
	mu        sync.Mutex
	byHandle  map[string]*mediaHandle
	bySession map[*sess]map[string]struct{}
	ctxs      map[*sess]context.Context
	cancels   map[*sess]context.CancelFunc
	bandwidth mediaBandwidth
}

func newMediaRegistry() *mediaRegistry {
	return &mediaRegistry{
		byHandle:  map[string]*mediaHandle{},
		bySession: map[*sess]map[string]struct{}{},
		ctxs:      map[*sess]context.Context{},
		cancels:   map[*sess]context.CancelFunc{},
		bandwidth: newMediaBandwidth(),
	}
}

func newMediaHandleID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "media_" + hex.EncodeToString(raw[:]), nil
}

func (e *Engine) mediaPut(h *mediaHandle) error {
	e.media.mu.Lock()
	defer e.media.mu.Unlock()
	e.mu.Lock()
	live := h.session != nil && h.session.state == "established" && e.sessions[h.session.routeID] == h.session
	e.mu.Unlock()
	if !live {
		return errMediaClosed
	}
	if len(e.media.byHandle) >= maxMediaHandlesGlobal {
		return errMediaQuota
	}
	owned := e.media.bySession[h.session]
	if len(owned) >= maxMediaHandlesSession {
		return errMediaQuota
	}
	if owned == nil {
		owned = map[string]struct{}{}
		e.media.bySession[h.session] = owned
	}
	e.media.byHandle[h.id] = h
	owned[h.id] = struct{}{}
	h.timer = time.AfterFunc(time.Until(h.deadline), func() { e.mediaExpire(h.id) })
	return nil
}

func (e *Engine) mediaExpire(id string) {
	e.media.mu.Lock()
	h := e.media.byHandle[id]
	if h == nil || time.Now().Before(h.deadline) {
		e.media.mu.Unlock()
		return
	}
	e.media.removeLocked(h)
	e.media.mu.Unlock()
	_ = h.file.Close()
}

func (e *Engine) mediaTouch(h *mediaHandle) {
	idle := time.Now().Add(mediaHandleIdle)
	abs := h.opened.Add(mediaHandleTTL)
	if idle.After(abs) {
		h.deadline = abs
	} else {
		h.deadline = idle
	}
	if h.timer != nil {
		h.timer.Reset(time.Until(h.deadline))
	}
}

// mediaHandleInstalled is a pure in-memory authority check (no filesystem or
// Runtime Snapshot I/O): the handle is still registered and owned by this exact
// session epoch. Safe to call while holding s.sendMu; it does not call into the
// send path or any lock that could recurse back into sendMu.
func (e *Engine) mediaHandleInstalled(s *sess, h *mediaHandle) bool {
	e.media.mu.Lock()
	defer e.media.mu.Unlock()
	cur := e.media.byHandle[h.id]
	return cur == h && cur.session == s
}

func (e *Engine) mediaLookup(s *sess, id string) (*mediaHandle, bool) {
	e.media.mu.Lock()
	defer e.media.mu.Unlock()
	h := e.media.byHandle[id]
	// Identity is the immutable session owner; a P2P commit changes s.routeID but
	// keeps the same session, so the route must not gate a handle here.
	if h == nil || h.session != s {
		return nil, false
	}
	if time.Now().After(h.deadline) {
		e.media.removeLocked(h)
		go func() { _ = h.file.Close() }()
		return nil, false
	}
	e.mediaTouch(h)
	return h, true
}

func (e *Engine) mediaDrop(s *sess, id string) *mediaHandle {
	e.media.mu.Lock()
	defer e.media.mu.Unlock()
	h := e.media.byHandle[id]
	if h == nil {
		return nil
	}
	if s != nil && h.session != s {
		return h
	}
	e.media.removeLocked(h)
	return h
}

func (e *Engine) mediaLiveContext(s *sess) (context.Context, error) {
	e.media.mu.Lock()
	defer e.media.mu.Unlock()
	e.mu.Lock()
	live := s != nil && s.state == "established" && e.sessions[s.routeID] == s
	e.mu.Unlock()
	if !live {
		return nil, errMediaClosed
	}
	if ctx := e.media.ctxs[s]; ctx != nil {
		return ctx, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := e.media.bandwidth.bind(s); err != nil {
		cancel()
		return nil, err
	}
	e.media.ctxs[s] = ctx
	e.media.cancels[s] = cancel
	return ctx, nil
}

func (e *Engine) closeSessionMedia(s *sess) {
	if s == nil {
		return
	}
	e.media.mu.Lock()
	if cancel := e.media.cancels[s]; cancel != nil {
		cancel()
		delete(e.media.cancels, s)
		delete(e.media.ctxs, s)
	}
	owned := e.media.bySession[s]
	handles := make([]*mediaHandle, 0, len(owned))
	for id := range owned {
		if h := e.media.byHandle[id]; h != nil && h.session == s {
			e.media.removeLocked(h)
			handles = append(handles, h)
		}
	}
	e.media.bandwidth.dropSession(s)
	e.media.mu.Unlock()
	for _, h := range handles {
		_ = h.file.Close()
	}
}

func (r *mediaRegistry) removeLocked(h *mediaHandle) {
	if h.timer != nil {
		h.timer.Stop()
		h.timer = nil
	}
	delete(r.byHandle, h.id)
	if owned := r.bySession[h.session]; owned != nil {
		delete(owned, h.id)
		if len(owned) == 0 {
			delete(r.bySession, h.session)
		}
	}
}

type mediaQuotaError struct{}

func (mediaQuotaError) Error() string { return "too many media handles are already open" }

type mediaRateError struct{}

func (mediaRateError) Error() string { return "media bandwidth quota exhausted" }

type mediaClosedError struct{}

func (mediaClosedError) Error() string { return "media session is no longer established" }

var errMediaQuota mediaQuotaError
var errMediaRate mediaRateError
var errMediaClosed mediaClosedError
