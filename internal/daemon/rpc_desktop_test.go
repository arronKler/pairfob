package daemon

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/audit"
	"pairfob/internal/crypto/aead"
	"pairfob/internal/mux"
	"pairfob/internal/remotedesktop"
	"pairfob/internal/runtime"
)

type testDesktop struct {
	allow atomic.Bool
	count atomic.Int32
	done  chan struct{}
}

func (h *testDesktop) Policy() remotedesktop.Policy {
	return remotedesktop.Policy{View: h.allow.Load(), Control: true}
}
func (h *testDesktop) Open(ctx context.Context, _ string, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	go func() { <-ctx.Done(); close(h.done) }()
	return h, remotedesktop.Result{SDP: "answer", Display: "screen", Control: r.Control}, nil
}
func (h *testDesktop) Input(remotedesktop.Event) error { h.count.Add(1); return nil }
func (h *testDesktop) Observe(observe, keyframe bool) remotedesktop.StreamObservation {
	return remotedesktop.StreamObservation{RTPTime: 420, Healthy: observe && keyframe, EncodeMS: 2.5}
}
func (h *testDesktop) Done() <-chan struct{} { return h.done }

func TestDesktopRequiresOwnerDirectLease(t *testing.T) {
	for _, control := range []bool{true, false} {
		h := &testDesktop{done: make(chan struct{})}
		h.allow.Store(true)
		e, c := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) { e.Desktop = h; e.Direct = &blockingDirectAcceptor{} })
		const id = "op_AAECAwQFBgcICQoL"
		req := remotedesktop.Request{OperationID: id, SDP: "offer", Quality: "motion", Control: control}
		if _, err := c.RPC("DesktopOpen", req); err == nil || err.Error() != "forbidden" {
			t.Fatalf("relay: %v", err)
		}
		markPhoneSessionP2P(t, e, c)
		if _, err := c.RPC("DesktopOpen", req); err != nil {
			t.Fatal(err)
		}
		if _, err := c.RPC("DesktopOpen", req); err == nil {
			t.Fatal("occupied slot accepted")
		}
		if _, err := c.RPC("DesktopPing", map[string]string{"desktop_id": "op_wrongdesktop12345678"}); err == nil {
			t.Fatal("wrong desktop accepted")
		}
		if _, err := c.RPC("DesktopPing", map[string]any{"desktop_id": id, "keyframe": true}); err == nil {
			t.Fatal("requested recovery without observation")
		}
		raw, err := c.RPC("DesktopPing", map[string]any{"desktop_id": id, "observe": true, "keyframe": true})
		var status remotedesktop.StreamObservation
		if err != nil || json.Unmarshal(raw, &status) != nil || !status.Healthy || status.RTPTime != 420 {
			t.Fatalf("direct status: %s, %v", raw, err)
		}
		in := map[string]any{"desktop_id": id, "operation_id": id + "_1", "sequence": 1, "event": map[string]string{"kind": "text", "text": "hello"}}
		_, err = c.RPC("DesktopInput", in)
		if (err == nil) != control {
			t.Fatalf("control %v: %v", control, err)
		}
		if _, err = c.RPC("DesktopInput", in); err == nil {
			t.Fatal("duplicate applied")
		}
		if control && h.count.Load() != 1 || !control && h.count.Load() != 0 {
			t.Fatal("input count")
		}
		if control {
			h.allow.Store(false)
		} else {
			e.mu.Lock()
			route := e.byDevice[c.DeviceID]
			e.mu.Unlock()
			e.closeSession(route, "disconnected", false)
		}
		select {
		case <-h.done:
		case <-time.After(2 * time.Second):
			t.Fatal("revocation did not close stream")
		}
	}
}

// Each media stream belongs to a fresh remote session, but both use the same local grant.
type reconnectDesktopHost struct{ grant atomic.Value }

func (h *reconnectDesktopHost) Policy() remotedesktop.Policy {
	return remotedesktop.Policy{View: true, Control: true, GrantID: h.grant.Load().(string)}
}
func (h *reconnectDesktopHost) Open(ctx context.Context, device string, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	stream := &testDesktop{done: make(chan struct{})}
	return stream.Open(ctx, device, r)
}

func TestDesktopReconnectUsesStandingGrant(t *testing.T) {
	h := &reconnectDesktopHost{}
	h.grant.Store("first")
	e, c := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) { e.Desktop = h; e.Direct = &blockingDirectAcceptor{} })
	markPhoneSessionP2P(t, e, c)
	for i, id := range []string{"op_AAECAwQFBgcICQoL", "op_BBECAwQFBgcICQoL"} {
		if _, err := c.RPC("DesktopOpen", remotedesktop.Request{OperationID: id, Quality: "balanced", SDP: "offer", Control: true}); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			// A delayed close for the retired ID acknowledges only that old stream.
			if _, err := c.RPC("DesktopClose", map[string]string{"desktop_id": "op_AAECAwQFBgcICQoL", "operation_id": "op_DDECAwQFBgcICQoL"}); err != nil {
				t.Fatal(err)
			}
			if _, err := c.RPC("DesktopPing", map[string]string{"desktop_id": id}); err != nil {
				t.Fatal(err)
			}
			h.grant.Store("replacement")
			if _, err := c.RPC("DesktopPing", map[string]string{"desktop_id": id}); err == nil {
				t.Fatal("previous grant survived replacement")
			}
			return
		}
		if _, err := c.RPC("DesktopClose", map[string]string{"desktop_id": id, "operation_id": "op_CCECAwQFBgcICQoL"}); err != nil {
			t.Fatal(err)
		}

	}
}

type policyDesktopHost struct{ policy remotedesktop.Policy }

func (h policyDesktopHost) Policy() remotedesktop.Policy { return h.policy }
func (h policyDesktopHost) Open(context.Context, string, remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	return nil, remotedesktop.Result{}, remotedesktop.ErrUnavailable
}

func TestGetConfigAdvertisesSetupDesktopCapability(t *testing.T) {
	tests := []struct {
		name        string
		desktop     remotedesktop.Host
		direct      bool
		wantSetup   bool
		wantView    bool
		wantControl bool
		wantAudio   bool
	}{
		{name: "no desktop host", desktop: nil, direct: true},
		{name: "direct disabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true, View: true, Control: true}}, direct: false},
		{name: "unsupported OS", desktop: policyDesktopHost{remotedesktop.Policy{Supported: false}}, direct: true},
		{name: "supported OS not enabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true}}, direct: true, wantSetup: true},
		{name: "supported OS view enabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true, View: true}}, direct: true, wantSetup: true, wantView: true, wantAudio: true},
		{name: "supported OS control enabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true, View: true, Control: true}}, direct: true, wantSetup: true, wantView: true, wantControl: true, wantAudio: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, client := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) {
				e.Desktop = tc.desktop
				if tc.direct {
					e.Direct = &blockingDirectAcceptor{}
				}
			})
			raw, err := client.RPC("GetConfig", map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			caps := decodeResult(t, raw)["capabilities"].(map[string]any)
			if caps["setup_desktop"] != tc.wantSetup ||
				caps["view_desktop"] != tc.wantView ||
				caps["control_desktop"] != tc.wantControl ||
				caps["listen_desktop_audio"] != tc.wantAudio {
				t.Fatalf("desktop capabilities = %v, want setup=%v view=%v control=%v audio=%v",
					caps, tc.wantSetup, tc.wantView, tc.wantControl, tc.wantAudio)
			}
		})
	}
}

type rpcReply struct {
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func newDirectDesktopSession(t *testing.T, e *Engine, deviceID string) (*sess, func() rpcReply) {
	t.Helper()
	var key [32]byte
	_, _ = rand.Read(key[:])
	var route [16]byte
	_, _ = rand.Read(route[:])
	serverConn, clientConn := mux.NewPipePair(32)
	t.Cleanup(func() {
		serverConn.Close()
		clientConn.Close()
	})
	s := &sess{
		routeID:   route,
		deviceID:  deviceID,
		link:      serverConn,
		transport: "p2p",
		state:     "established",
		c2s:       &aead.Direction{Key: key[:], Dir: aead.DirClient},
		s2c:       &aead.Direction{Key: key[:], Dir: aead.DirServer},
	}
	e.mu.Lock()
	e.sessions[route] = s
	e.mu.Unlock()
	t.Cleanup(s.stopWrites)
	recv := &aead.Direction{Key: key[:], Dir: aead.DirServer}
	readReply := func() rpcReply {
		t.Helper()
		f, ok := clientConn.Recv()
		if !ok {
			t.Fatal("clientConn closed")
		}
		pt, err := aead.Open(recv, route, f.Payload)
		if err != nil {
			t.Fatal(err)
		}
		var rep rpcReply
		if err := json.Unmarshal(pt, &rep); err != nil {
			t.Fatal(err)
		}
		return rep
	}
	return s, readReply
}

type scriptedStream struct {
	done        chan struct{}
	closeReason string
	releaseLag  time.Duration
}

func (s *scriptedStream) Input(remotedesktop.Event) error { return nil }
func (s *scriptedStream) Done() <-chan struct{}           { return s.done }
func (s *scriptedStream) CloseReason() string             { return s.closeReason }

type scriptedDesktopHost struct {
	mu      sync.Mutex
	onOpen  func(ctx context.Context, req remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error)
	streams []*scriptedStream
}

func (h *scriptedDesktopHost) Policy() remotedesktop.Policy {
	return remotedesktop.Policy{Supported: true, View: true, Control: true, GrantID: "g1"}
}

func (h *scriptedDesktopHost) Open(ctx context.Context, label string, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	h.mu.Lock()
	fn := h.onOpen
	h.mu.Unlock()
	if fn != nil {
		return fn(ctx, r)
	}
	st := &scriptedStream{done: make(chan struct{})}
	h.mu.Lock()
	h.streams = append(h.streams, st)
	h.mu.Unlock()
	go func() {
		<-ctx.Done()
		close(st.done)
	}()
	return st, remotedesktop.Result{SDP: "answer", Display: "screen", Control: r.Control}, nil
}

func mustMarshalRaw(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func readAuditEvents(t *testing.T, path string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatal(err)
		}
		out = append(out, rec)
	}
	return out
}

func TestDesktopSameDevicePreemptionAndAuditOrder(t *testing.T) {
	auditPath := filepath.Join(t.TempDir(), "audit.log")
	logger, err := audit.Open(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()

	host := &scriptedDesktopHost{}
	e := NewEngine(nil, nil, runtime.NewFake())
	e.Desktop = host
	e.Direct = &blockingDirectAcceptor{}
	e.Audit = logger

	s1, recv1 := newDirectDesktopSession(t, e, "dev_same")
	s2, recv2 := newDirectDesktopSession(t, e, "dev_same")
	s3, recv3 := newDirectDesktopSession(t, e, "dev_other")

	const id1 = "op_AAECAwQFBgcICQoL"
	const id2 = "op_BBECAwQFBgcICQoL"
	const id3 = "op_CCECAwQFBgcICQoL"

	e.rpcDesktopOpen(s1, "r1", mustMarshalRaw(t, remotedesktop.Request{OperationID: id1, SDP: "offer", Quality: "balanced", Control: true}))
	if rep := recv1(); !rep.OK {
		t.Fatalf("s1 open failed: %+v", rep.Error)
	}

	// Same device preempts active slot.
	e.rpcDesktopOpen(s2, "r2", mustMarshalRaw(t, remotedesktop.Request{OperationID: id2, SDP: "offer", Quality: "balanced", Control: true}))
	if rep := recv2(); !rep.OK {
		t.Fatalf("s2 open failed: %+v", rep.Error)
	}

	// Old session gets "kicked" on subsequent ping and input.
	e.rpcDesktopCommand(s1, "r3", "DesktopPing", mustMarshalRaw(t, map[string]any{"desktop_id": id1}))
	if rep := recv1(); rep.OK || rep.Error == nil || rep.Error.Code != "kicked" || rep.Error.Message != "desktop session taken over by another window" {
		t.Fatalf("s1 ping after preemption = %+v", rep)
	}
	e.rpcDesktopCommand(s1, "r4", "DesktopInput", mustMarshalRaw(t, map[string]any{
		"desktop_id": id1, "operation_id": id1 + "_1", "sequence": 1,
		"event": map[string]any{"kind": "release"},
	}))
	if rep := recv1(); rep.OK || rep.Error == nil || rep.Error.Code != "kicked" {
		t.Fatalf("s1 input after preemption = %+v", rep)
	}

	// Different device is still rejected with conflict.
	e.rpcDesktopOpen(s3, "r5", mustMarshalRaw(t, remotedesktop.Request{OperationID: id3, SDP: "offer", Quality: "balanced"}))
	if rep := recv3(); rep.OK || rep.Error == nil || rep.Error.Code != "conflict" {
		t.Fatalf("other device open = %+v", rep)
	}

	// New slot remains live.
	e.rpcDesktopCommand(s2, "r6", "DesktopPing", mustMarshalRaw(t, map[string]any{"desktop_id": id2}))
	if rep := recv2(); !rep.OK {
		t.Fatalf("s2 ping failed: %+v", rep.Error)
	}

	// Verify desktop_closed (reason=preempted) is audited strictly before the new desktop_open.
	events := readAuditEvents(t, auditPath)
	closedIdx, secondOpenIdx := -1, -1
	openCount := 0
	for i, ev := range events {
		if ev["op"] == "desktop_closed" && ev["reason"] == "preempted" && closedIdx == -1 {
			closedIdx = i
		}
		if ev["op"] == "desktop_open" {
			openCount++
			if openCount == 2 {
				secondOpenIdx = i
			}
		}
	}
	if closedIdx == -1 || secondOpenIdx == -1 || closedIdx >= secondOpenIdx {
		t.Fatalf("audit order invalid: closedIdx=%d secondOpenIdx=%d events=%v", closedIdx, secondOpenIdx, events)
	}
}

func TestDesktopPreemptionDuringPendingOpenAndConcurrencyGuard(t *testing.T) {
	started := make(chan struct{})
	releaseLagDone := make(chan struct{})
	host := &scriptedDesktopHost{
		onOpen: func(ctx context.Context, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
			if r.OperationID == "op_AAECAwQFBgcICQoL" {
				close(started)
				<-ctx.Done()
				return nil, remotedesktop.Result{}, ctx.Err()
			}
			st := &scriptedStream{done: make(chan struct{})}
			go func() {
				<-ctx.Done()
				if r.OperationID == "op_BBECAwQFBgcICQoL" {
					time.Sleep(150 * time.Millisecond)
					close(releaseLagDone)
				}
				close(st.done)
			}()
			return st, remotedesktop.Result{SDP: "answer", Display: "screen", Control: r.Control}, nil
		},
	}
	e := NewEngine(nil, nil, runtime.NewFake())
	e.Desktop = host
	e.Direct = &blockingDirectAcceptor{}

	s1, recv1 := newDirectDesktopSession(t, e, "dev_same")
	s2, recv2 := newDirectDesktopSession(t, e, "dev_same")
	s3, recv3 := newDirectDesktopSession(t, e, "dev_same")
	s4, recv4 := newDirectDesktopSession(t, e, "dev_same")

	e.rpcDesktopOpen(s1, "r1", mustMarshalRaw(t, remotedesktop.Request{OperationID: "op_AAECAwQFBgcICQoL", SDP: "offer", Quality: "balanced"}))
	<-started
	e.rpcDesktopOpen(s2, "r2", mustMarshalRaw(t, remotedesktop.Request{OperationID: "op_BBECAwQFBgcICQoL", SDP: "offer", Quality: "balanced"}))
	if rep := recv1(); rep.OK || rep.Error == nil || rep.Error.Code != "kicked" {
		t.Fatalf("pending s1 open = %+v, want kicked", rep)
	}
	if rep := recv2(); !rep.OK {
		t.Fatalf("s2 open = %+v", rep)
	}

	// s3 preempts s2 (whose stream lags 150ms before Done closes); s4 concurrent preemption gets conflict.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		e.rpcDesktopOpen(s3, "r3", mustMarshalRaw(t, remotedesktop.Request{OperationID: "op_CCECAwQFBgcICQoL", SDP: "offer", Quality: "balanced"}))
	}()
	deadline := time.Now().Add(time.Second)
	for {
		e.mu.Lock()
		preempting := e.desktopPreempting
		e.mu.Unlock()
		if preempting || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.rpcDesktopOpen(s4, "r4", mustMarshalRaw(t, remotedesktop.Request{OperationID: "op_DDECAwQFBgcICQoL", SDP: "offer", Quality: "balanced"}))
	if rep := recv4(); rep.OK || rep.Error == nil || rep.Error.Code != "conflict" {
		t.Fatalf("concurrent preemption s4 = %+v, want conflict", rep)
	}
	<-releaseLagDone
	wg.Wait()
	if rep := recv3(); !rep.OK {
		t.Fatalf("s3 open = %+v", rep)
	}
}

func TestDesktopStructuredCloseAndStartupReasons(t *testing.T) {
	reasons := []string{"locked", "sleeping", "perm_screen", "perm_accessibility", "stopped_on_host", "display_unavailable"}
	for _, code := range reasons {
		t.Run(code, func(t *testing.T) {
			auditPath := filepath.Join(t.TempDir(), "audit.log")
			logger, err := audit.Open(auditPath)
			if err != nil {
				t.Fatal(err)
			}
			defer logger.Close()

			st := &scriptedStream{done: make(chan struct{}), closeReason: code}
			host := &scriptedDesktopHost{
				onOpen: func(ctx context.Context, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
					return st, remotedesktop.Result{SDP: "answer", Display: "screen"}, nil
				},
			}
			e := NewEngine(nil, nil, runtime.NewFake())
			e.Desktop = host
			e.Direct = &blockingDirectAcceptor{}
			e.Audit = logger

			s, recv := newDirectDesktopSession(t, e, "dev_reason")
			const deskID = "op_AAECAwQFBgcICQoL"
			e.rpcDesktopOpen(s, "r1", mustMarshalRaw(t, remotedesktop.Request{OperationID: deskID, SDP: "offer", Quality: "balanced"}))
			if rep := recv(); !rep.OK {
				t.Fatalf("open = %+v", rep)
			}

			close(st.done)
			deadline := time.Now().Add(time.Second)
			for {
				e.mu.Lock()
				cleared := e.desktop == nil
				e.mu.Unlock()
				if cleared || time.Now().After(deadline) {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}

			e.rpcDesktopCommand(s, "r2", "DesktopPing", mustMarshalRaw(t, map[string]any{"desktop_id": deskID}))
			rep := recv()
			wantMsg := "[reason:" + code + "] desktop session is closed"
			if rep.OK || rep.Error == nil || rep.Error.Code != "forbidden" || rep.Error.Message != wantMsg {
				t.Fatalf("ping after %s = %+v, want forbidden %q", code, rep, wantMsg)
			}
			e.rpcDesktopCommand(s, "r3", "DesktopClose", mustMarshalRaw(t, map[string]any{"desktop_id": deskID, "operation_id": "op_BBECAwQFBgcICQoL"}))
			if rep := recv(); !rep.OK {
				t.Fatalf("close after %s = %+v", code, rep)
			}

			events := readAuditEvents(t, auditPath)
			found := false
			for _, ev := range events {
				if ev["op"] == "desktop_closed" && ev["reason"] == code {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing desktop_closed audit with reason=%s in %v", code, events)
			}
		})
	}

	t.Run("bounded_history_and_startup_normalize", func(t *testing.T) {
		auditPath := filepath.Join(t.TempDir(), "audit.log")
		logger, err := audit.Open(auditPath)
		if err != nil {
			t.Fatal(err)
		}
		defer logger.Close()

		e := NewEngine(nil, nil, runtime.NewFake())
		e.Audit = logger
		e.Direct = &blockingDirectAcceptor{}
		e.Desktop = &scriptedDesktopHost{
			onOpen: func(ctx context.Context, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
				return nil, remotedesktop.Result{}, errors.New("Unlock this Mac to share a display")
			},
		}
		s, recv := newDirectDesktopSession(t, e, "dev_start")
		e.mu.Lock()
		for i := 0; i < 40; i++ {
			e.recordDesktopEndedLocked(fmt.Sprintf("op_%016d", i), s, "locked")
		}
		n := len(e.desktopEnded.byID)
		_, hasOldest := e.desktopEnded.byID[fmt.Sprintf("op_%016d", 0)]
		_, hasNewest := e.desktopEnded.byID[fmt.Sprintf("op_%016d", 39)]
		e.mu.Unlock()
		if n != maxDesktopEnded || hasOldest || !hasNewest {
			t.Fatalf("desktopEnded cap broken: len=%d oldest=%v newest=%v", n, hasOldest, hasNewest)
		}

		e.rpcDesktopOpen(s, "r1", mustMarshalRaw(t, remotedesktop.Request{OperationID: "op_AAECAwQFBgcICQoL", SDP: "offer", Quality: "balanced"}))
		rep := recv()
		if rep.OK || rep.Error == nil || rep.Error.Code != "conflict" || rep.Error.Message != "[reason:locked] Unlock this Mac to share a display" {
			t.Fatalf("startup error = %+v", rep)
		}
		events := readAuditEvents(t, auditPath)
		if len(events) != 1 || events[0]["op"] != "desktop_open_failed" || events[0]["reason"] != "locked" {
			t.Fatalf("unexpected startup audit: %v", events)
		}
	})
}
