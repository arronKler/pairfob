package daemon

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	goruntime "runtime"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

type queueFullOnceConn struct {
	mu    sync.Mutex
	calls int
}

func (c *queueFullOnceConn) Send(envelope.Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	if c.calls == 1 {
		return errors.New("queue full")
	}
	return nil
}

func (*queueFullOnceConn) Close() {}

func (c *queueFullOnceConn) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

type failNthConn struct {
	mu      sync.Mutex
	failOn  int
	sends   int
	frames  []envelope.Frame
	closed  bool
	closeCh chan struct{}
	once    sync.Once
	onSend  func()
}

func newFailNthConn(failOn int) *failNthConn {
	return &failNthConn{failOn: failOn, closeCh: make(chan struct{})}
}

func (c *failNthConn) Send(frame envelope.Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.onSend != nil {
		c.onSend()
	}
	if c.closed {
		return errors.New("P2P data channel is not open")
	}
	c.sends++
	if c.failOn > 0 && c.sends == c.failOn {
		return errors.New("P2P send queue is full")
	}
	c.frames = append(c.frames, frame)
	return nil
}

func (c *failNthConn) Close() {
	c.once.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		close(c.closeCh)
	})
}

func (c *failNthConn) snapshot() (int, []envelope.Frame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	frames := append([]envelope.Frame(nil), c.frames...)
	return len(frames), frames, c.closed
}

type nopTerminal struct {
	events chan runtime.TerminalEvent
	once   sync.Once
}

func (t *nopTerminal) Events() <-chan runtime.TerminalEvent { return t.events }
func (t *nopTerminal) Input([]byte) error                   { return nil }
func (t *nopTerminal) Resize(runtime.TerminalResize) error  { return nil }
func (t *nopTerminal) Scroll(runtime.TerminalScroll) error  { return nil }
func (t *nopTerminal) Close() error {
	t.once.Do(func() { close(t.events) })
	return nil
}

func establishedSendSession(t *testing.T, link mux.Conn) (*Engine, *sess, []byte) {
	t.Helper()
	relay, _ := mux.NewPipePair(8)
	engine := NewEngine(nil, relay, runtime.NewFake())
	route := [16]byte{9, 8, 7, 6}
	key := randomTestBytes(t, 32)
	session := &sess{
		routeID: route, deviceID: "dev_sendfail", state: "established", transport: "p2p",
		link:     link,
		s2c:      &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer},
		rpcQueue: make(chan rpcRequest, sessionRPCQueueSize), rpcStop: make(chan struct{}),
	}
	engine.mu.Lock()
	engine.sessions[route] = session
	engine.byDevice[session.deviceID] = route
	engine.mu.Unlock()
	t.Cleanup(func() { stopSessionRPC(session) })
	return engine, session, key
}

func waitSessionGone(t *testing.T, engine *Engine, route [16]byte) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if engine.Session(route) == nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("session epoch was not failed after post-seal send failure")
}

func TestReplyQueueFullFailsEpochWithoutRollingBackSeq(t *testing.T) {
	link := newFailNthConn(1)
	engine, session, _ := establishedSendSession(t, link)
	var seqAtSend uint64
	link.onSend = func() { seqAtSend = session.s2c.Seq }
	if engine.reply(session, "req_1", map[string]any{"ok": true}) {
		t.Fatal("reply succeeded on a full queue")
	}
	if seqAtSend != 1 {
		t.Fatalf("seq at post-seal send=%d, want 1 consumed and not rolled back", seqAtSend)
	}
	waitSessionGone(t, engine, session.routeID)
	select {
	case <-link.closeCh:
	case <-time.After(time.Second):
		t.Fatal("full queue did not close the P2P link")
	}
	n, _, closed := link.snapshot()
	if n != 0 || !closed {
		t.Fatalf("frames=%d closed=%v, want no delivered ciphertext on the rejected send", n, closed)
	}
	if engine.reply(session, "req_2", map[string]any{"ok": true}) {
		t.Fatal("reply reused a failed epoch after the buffer could drain")
	}
	nAfter, _, _ := link.snapshot()
	if nAfter != 0 {
		t.Fatal("dead epoch sent a frame after simulated drain")
	}
}

func TestTerminalPartialSendFailureDoesNotNotifyOnDeadLink(t *testing.T) {
	link := newFailNthConn(2)
	engine, session, _ := establishedSendSession(t, link)
	slot := &terminalSlot{
		id:         "term_" + hex.EncodeToString(make([]byte, 16)),
		paneID:     "w0:p1",
		controller: &nopTerminal{events: make(chan runtime.TerminalEvent)},
	}
	session.terminal = slot
	frame := runtime.TerminalFrame{
		Sequence: 1, Width: 80, Height: 24, Full: true,
		Data: make([]byte, terminalFrameChunk+8),
	}
	var seqAtSend []uint64
	link.onSend = func() { seqAtSend = append(seqAtSend, session.s2c.Seq) }
	delivered, transportFailed := engine.sendTerminalFrame(session, slot, frame)
	if delivered || !transportFailed {
		t.Fatalf("delivered=%v transportFailed=%v", delivered, transportFailed)
	}
	if len(seqAtSend) != 2 || seqAtSend[0] != 1 || seqAtSend[1] != 2 {
		t.Fatalf("seq at sends=%v, want 1 then 2 with no nonce rollback", seqAtSend)
	}
	engine.closeTerminalSlot(session, slot, "terminal frame could not be delivered", !transportFailed)
	n, frames, _ := link.snapshot()
	if n != 1 {
		t.Fatalf("frames=%d, want only the delivered prefix (no TerminalClosed on the jammed link)", n)
	}
	if frames[0].Typ != envelope.TypFWD {
		t.Fatalf("prefix typ=%d", frames[0].Typ)
	}
	waitSessionGone(t, engine, session.routeID)
	if engine.reply(session, "req_after", map[string]any{"t": 1}) {
		t.Fatal("reply reused the failed terminal epoch")
	}
	nAfter, _, closed := link.snapshot()
	if nAfter != 1 || !closed {
		t.Fatalf("after drain frames=%d closed=%v", nAfter, closed)
	}
}

func TestFailedEpochCannotSendAgainBeforeCleanupRuns(t *testing.T) {
	old := goruntime.GOMAXPROCS(1)
	defer goruntime.GOMAXPROCS(old)
	link := &queueFullOnceConn{}
	engine := NewEngine(nil, link, runtime.NewFake())
	route := [16]byte{1}
	session := &sess{
		routeID: route, deviceID: "dev_review", state: "established", transport: "p2p",
		link: link, s2c: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirServer},
	}
	engine.sessions[route] = session
	engine.byDevice[session.deviceID] = route
	first := engine.reply(session, "first", map[string]any{"ok": true})
	second := engine.reply(session, "second", map[string]any{"ok": true})
	if first || second || link.count() != 1 {
		t.Fatalf("after failed epoch: first=%v second=%v wire attempts=%d", first, second, link.count())
	}
}

func TestFailedEpochCleanupDoesNotCloseReplacementAtSameRoute(t *testing.T) {
	old := goruntime.GOMAXPROCS(1)
	defer goruntime.GOMAXPROCS(old)
	oldLink := newFailNthConn(1)
	engine, failed, _ := establishedSendSession(t, oldLink)
	route := failed.routeID
	if engine.reply(failed, "req_old", map[string]any{"ok": true}) {
		t.Fatal("failed epoch reply succeeded")
	}
	replacementLink := newFailNthConn(0)
	replacement := &sess{
		routeID: route, deviceID: "dev_replacement", state: "established", transport: "p2p",
		link:     replacementLink,
		s2c:      &aead.Direction{Key: randomTestBytes(t, 32), Dir: aead.DirServer},
		rpcQueue: make(chan rpcRequest, sessionRPCQueueSize), rpcStop: make(chan struct{}),
	}
	engine.mu.Lock()
	engine.sessions[route] = replacement
	engine.byDevice[replacement.deviceID] = route
	engine.mu.Unlock()
	t.Cleanup(func() { stopSessionRPC(replacement) })
	select {
	case <-oldLink.closeCh:
	case <-time.After(2 * time.Second):
		t.Fatal("failed epoch did not finish pointer cleanup")
	}
	if engine.Session(route) != replacement {
		t.Fatal("cleanup removed or replaced the new session at the same route")
	}
	if !engine.reply(replacement, "req_new", map[string]any{"ok": true}) {
		t.Fatal("replacement epoch could not send")
	}
	n, _, closed := replacementLink.snapshot()
	if n != 1 || closed {
		t.Fatalf("replacement frames=%d closed=%v", n, closed)
	}
}

func TestSendPokeSkipsFailedEpochBeforeSeal(t *testing.T) {
	link := newFailNthConn(0)
	engine, session, _ := establishedSendSession(t, link)
	session.epochFailed.Store(true)
	seq := session.s2c.Seq
	engine.sendPoke("agent_status", "w0:p1")
	if session.s2c.Seq != seq {
		t.Fatalf("sendPoke sealed on a failed epoch: seq=%d", session.s2c.Seq)
	}
	n, _, _ := link.snapshot()
	if n != 0 {
		t.Fatalf("sendPoke wrote %d frames on a failed epoch", n)
	}
}

func TestSendFailureDropsSessionSoLaterInboundCannotUseGappedKeys(t *testing.T) {
	link := newFailNthConn(1)
	engine, session, _ := establishedSendSession(t, link)
	engine.replyErr(session, "req_err", "internal", "boom")
	waitSessionGone(t, engine, session.routeID)
	if engine.Session(session.routeID) != nil {
		t.Fatal("failed epoch remained registered")
	}
	body, _ := json.Marshal(map[string]any{"v": 1, "id": "req_late", "op": "Ping", "params": map[string]any{"t_ms": 1}})
	payload, err := aead.Seal(&aead.Direction{Key: make([]byte, 32), Dir: aead.DirClient}, session.routeID, body)
	if err != nil {
		t.Fatal(err)
	}
	engine.handleFWD(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: session.routeID, Payload: payload})
	n, _, _ := link.snapshot()
	if n != 0 {
		t.Fatalf("dropped session still answered inbound FWD: %d", n)
	}
}
