// Package mux is the in-process frame relay used by daemon tests.
// The product origin is workers/pairfob-origin. This Hub never parses FWD payloads.
package mux

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"time"

	"pairfob/internal/envelope"
)

type Conn interface {
	Send(envelope.Frame) error
	Close()
}

type kind int

const (
	kindNone kind = iota
	kindPairing
	kindResumeHello
	kindEstablished
)

type bind struct {
	id         [16]byte
	client     Conn
	daemon     *daemonSlot
	kind       kind
	timer      *time.Timer
	created    time.Time
	pairFrames int
}

type daemonSlot struct {
	id             string
	conn           Conn
	reconnectToken string
	binds          map[[16]byte]*bind
	pairSlots      map[string]*pairSlot // pair_ref hex
}

type pairSlot struct {
	ref      string
	bind     *bind
	deadline time.Time
	timer    *time.Timer
}

type Hub struct {
	mu              sync.Mutex
	joinHash        string
	daemons         map[string]*daemonSlot
	reconnect       map[string]string // SHA-256(token) -> daemon_id
	diskReconnect   map[string]string // last registry snapshot; kicked hashes must not be rewritten
	clients         map[Conn]*clientState
	statePath       string
	now             func() time.Time
	ttlPair         time.Duration
	helloGrace      time.Duration
	resumeWait      time.Duration
	pairFirstFrame  time.Duration
	pairConfirmWait time.Duration
}

// pendingSend is flushed after h.mu is released so a slow websocket write
// cannot stall pairing replace, ResumeHello timers, or other FWD.
type pendingSend struct {
	c     Conn
	f     envelope.Frame
	close bool
}

type clientState struct {
	conn    Conn
	daemon  *daemonSlot
	bind    *bind
	mode    string // pairing | session | ""
	hello   bool
	helloAt time.Time
	timer   *time.Timer
}

func NewHub(joinToken string) *Hub {
	h, _ := newHub(joinToken, "")
	return h
}

// NewPersistentHub retains only the join-token hash plus reconnect-token
// hashes and daemon IDs. This lets already-registered daemons reconnect after
// a relay process restart without persisting live binds or pairing slots.
func NewPersistentHub(joinToken, statePath string) (*Hub, error) {
	if statePath == "" {
		return nil, errors.New("empty relay state path")
	}
	return newHub(joinToken, statePath)
}

func newHub(joinToken, statePath string) (*Hub, error) {
	joinHash := ""
	if joinToken != "" {
		joinHash = tokenHash(joinToken)
	}
	h := &Hub{
		joinHash:      joinHash,
		daemons:       map[string]*daemonSlot{},
		reconnect:     map[string]string{},
		diskReconnect: map[string]string{},
		clients:       map[Conn]*clientState{},
		statePath:     statePath,
		now:           time.Now,
		ttlPair:       180 * time.Second,
		helloGrace:    5 * time.Second,
		resumeWait:    15 * time.Second,
		// NewHub is the in-process test relay. Leave enough time for the phone's
		// Argon2 work under the race detector before its first FWD frame.
		pairFirstFrame:  60 * time.Second,
		pairConfirmWait: 30 * time.Second,
	}
	if statePath != "" {
		if err := h.loadReconnectRegistry(); err != nil {
			return nil, err
		}
		if h.joinHash == "" {
			if joinToken == "" {
				return nil, errors.New("relay registry has no join token; bootstrap token required")
			}
			h.joinHash = tokenHash(joinToken)
		}
		if err := h.persistReconnectRegistryLocked(); err != nil {
			return nil, err
		}
	}
	return h, nil
}

func (h *Hub) HandleDaemon(c Conn, f envelope.Frame) {
	if err := envelope.Validate(f); err != nil {
		h.reject(c, "bad_frame", err.Error())
		return
	}
	if f.Typ != envelope.TypHELLO_DAEMON {
		h.mu.Lock()
		registered := h.daemonByConn(c) != nil
		h.mu.Unlock()
		if !registered {
			h.reject(c, "unbound", "HELLO_DAEMON must be the first frame")
			return
		}
	}
	switch f.Typ {
	case envelope.TypHELLO_DAEMON:
		h.registerDaemon(c, f)
	case envelope.TypPAIR_OPEN:
		h.pairOpen(c, f)
	case envelope.TypPAIR_CLOSE:
		h.pairClose(c, f)
	case envelope.TypFWD:
		h.fwdFromDaemon(c, f)
	case envelope.TypERROR:
		h.errorFromDaemon(c, f)
	case envelope.TypSESSION_ESTABLISHED:
		h.sessionEstablished(c, f)
	case envelope.TypPING:
		h.handlePing(c, f)
	case envelope.TypPONG:
		h.handlePong(c, f)
	default:
		h.reject(c, "unbound", "frame type is not valid on daemon websocket")
	}
}

func (h *Hub) HandleClient(c Conn, f envelope.Frame) {
	if err := envelope.Validate(f); err != nil {
		h.reject(c, "bad_frame", err.Error())
		return
	}
	h.mu.Lock()
	st, ok := h.clients[c]
	if !ok {
		st = &clientState{conn: c}
		h.clients[c] = st
	}
	h.mu.Unlock()
	h.mu.Lock()
	hello := st.hello
	h.mu.Unlock()
	if !hello && f.Typ != envelope.TypHELLO_CLIENT {
		h.reject(c, "unbound", "HELLO_CLIENT must be the first frame")
		return
	}
	switch f.Typ {
	case envelope.TypHELLO_CLIENT:
		h.clientHello(st, f)
	case envelope.TypPAIR_ATTACH:
		h.pairAttach(st, f)
	case envelope.TypSESSION_ATTACH:
		h.sessionAttach(st, f)
	case envelope.TypFWD:
		h.fwdFromClient(st, f)
	case envelope.TypPING:
		h.handlePing(c, f)
	case envelope.TypPONG:
		h.handlePong(c, f)
	case envelope.TypSESSION_ESTABLISHED:
		h.sendErr(c, envelope.ErrorBody{Code: "unbound", Message: "clients must not send SESSION_ESTABLISHED"})
	default:
		h.reject(c, "unbound", "frame type is not valid on client websocket")
	}
}

func (h *Hub) DropConn(c Conn) {
	h.mu.Lock()
	var pending []pendingSend
	if st, ok := h.clients[c]; ok {
		if st.timer != nil {
			st.timer.Stop()
			st.timer = nil
		}
		if st.bind != nil {
			pending = append(pending, h.queueDaemonUnpinLocked(st.bind, "unpaired", "client websocket gone")...)
		}
		delete(h.clients, c)
		h.mu.Unlock()
		flushPending(pending)
		return
	}
	for _, d := range h.daemons {
		if d.conn == c {
			pending = append(pending, h.dropDaemonLocked(d)...)
			h.mu.Unlock()
			flushPending(pending)
			return
		}
	}
	h.mu.Unlock()
}

func (h *Hub) daemonByConn(c Conn) *daemonSlot {
	for _, d := range h.daemons {
		if d.conn == c {
			return d
		}
	}
	return nil
}

// unbindLocked requires h.mu held.
func (h *Hub) unbindLocked(b *bind, _ string) {
	if b == nil {
		return
	}
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	delete(b.daemon.binds, b.id)
	for _, sl := range b.daemon.pairSlots {
		if sl.bind == b {
			sl.bind = nil
		}
	}
	for c, st := range h.clients {
		if st.bind == b {
			st.bind = nil
			st.daemon = nil
			_ = c
		}
	}
}

func flushPending(sends []pendingSend) {
	for _, s := range sends {
		if s.c == nil {
			continue
		}
		_ = s.c.Send(s.f)
		if s.close {
			s.c.Close()
		}
	}
}

func routeErrFrame(b *bind, code, msg string) envelope.Frame {
	return envelope.JSON(envelope.TypERROR, b.id, envelope.ErrorBody{
		Code: code, RouteID: hex.EncodeToString(b.id[:]), Message: msg,
	})
}

func (h *Hub) kickBindLocked(b *bind, code, msg string) []pendingSend {
	return h.queueCloseBindLocked(b, routeErrFrame(b, code, msg), true)
}

func (h *Hub) queueCloseBindLocked(b *bind, f envelope.Frame, notifyDaemon bool) []pendingSend {
	if b == nil {
		return nil
	}
	client := b.client
	daemon := b.daemon.conn
	h.unbindLocked(b, "closed")
	out := []pendingSend{{c: client, f: f, close: true}}
	if notifyDaemon && daemon != nil && f.Typ == envelope.TypERROR && !isZeroRID(f.RouteID) {
		out = append(out, pendingSend{c: daemon, f: f})
	}
	return out
}

func (h *Hub) queueDaemonUnpinLocked(b *bind, code, msg string) []pendingSend {
	if b == nil {
		return nil
	}
	daemon := b.daemon.conn
	f := routeErrFrame(b, code, msg)
	h.unbindLocked(b, "closed")
	if daemon == nil {
		return nil
	}
	return []pendingSend{{c: daemon, f: f}}
}

func (h *Hub) dropDaemonLocked(d *daemonSlot) []pendingSend {
	offline := envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{Code: "daemon_offline", Message: "daemon websocket gone"})
	var pending []pendingSend
	for _, b := range d.binds {
		pending = append(pending, h.queueCloseBindLocked(b, offline, false)...)
	}
	d.binds = map[[16]byte]*bind{}
	// Pairing slots are tied to the daemon websocket that opened them. Keeping
	// them would allow attaches to route into a nil/offline connection.
	h.clearPairSlotsLocked(d)
	d.conn = nil
	return pending
}

func (h *Hub) sendErr(c Conn, body envelope.ErrorBody) {
	if c == nil {
		return
	}
	_ = c.Send(envelope.JSON(envelope.TypERROR, [16]byte{}, body))
}

func (h *Hub) sendRouteErr(c Conn, rid [16]byte, body envelope.ErrorBody) {
	if c == nil {
		return
	}
	_ = c.Send(envelope.JSON(envelope.TypERROR, rid, body))
}

func (h *Hub) handlePing(c Conn, f envelope.Frame) {
	if len(f.Payload) != 8 {
		h.reject(c, "unbound", "PING payload must be exactly 8 bytes")
		return
	}
	if err := c.Send(envelope.Frame{Version: 1, Typ: envelope.TypPONG, Payload: append([]byte(nil), f.Payload...), RouteID: f.RouteID}); err != nil {
		c.Close()
	}
}

func (h *Hub) handlePong(c Conn, f envelope.Frame) {
	if len(f.Payload) != 8 {
		h.reject(c, "unbound", "PONG payload must be exactly 8 bytes")
	}
	// Receipt is sufficient; PONG never changes bind timers or state.
}

func (h *Hub) reject(c Conn, code, message string) {
	h.sendErr(c, envelope.ErrorBody{Code: code, Message: message})
	c.Close()
}

func randRID() ([16]byte, error) {
	var b [16]byte
	_, err := rand.Read(b[:])
	return b, err
}

func randHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

var (
	daemonIDPattern       = regexp.MustCompile(`^d_[0-9a-f]{20}$`)
	reconnectTokenPattern = regexp.MustCompile(`^rt_[0-9a-f]{32}$`)
)

func decodeJSON(payload []byte, dst any) error {
	if len(payload) == 0 {
		return errors.New("empty JSON payload")
	}
	if err := json.Unmarshal(payload, dst); err != nil {
		return err
	}
	var extra any
	if err := json.Unmarshal(payload, &extra); err != nil {
		return err
	}
	if _, ok := extra.(map[string]any); !ok {
		return errors.New("JSON payload must be an object")
	}
	return nil
}

func isZeroRID(rid [16]byte) bool { return rid == [16]byte{} }

func isLowerHex(s string, byteLen int) bool {
	if len(s) != byteLen*2 {
		return false
	}
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == byteLen && hex.EncodeToString(b) == s
}

// DaemonForTest returns daemon_id after register (tests).
func (h *Hub) DaemonIDs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var ids []string
	for id := range h.daemons {
		ids = append(ids, id)
	}
	return ids
}
