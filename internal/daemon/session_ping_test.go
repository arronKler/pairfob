package daemon

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"pairfob/internal/audit"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

// Drive encrypted ingress and read authenticated replies, including concurrently
// emitted normal/health responses, so tests cover admission and AEAD ordering.
func pingSession(t *testing.T, rt runtime.Runtime) (*Engine, *sess, func(string, string), func() map[string]any) {
	t.Helper()
	server, peer := mux.NewPipePair(64)
	engine := NewEngine(nil, server, rt)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	s := &sess{routeID: [16]byte{1}, state: "established", transport: "relay",
		c2s:      &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirClient},
		s2c:      &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer},
		rpcQueue: make(chan rpcRequest, sessionRPCQueueSize), pingQueue: make(chan rpcRequest, sessionPingQueueSize), rpcStop: make(chan struct{}),
	}
	engine.sessions[s.routeID] = s
	c2s := &aead.Direction{Key: key, Dir: aead.DirClient}
	s2c := &aead.Direction{Key: key, Dir: aead.DirServer}
	t.Cleanup(func() { stopSessionRPC(s) })
	send := func(id, op string) {
		t.Helper()
		params := `{}`
		if op == "Ping" {
			params = `{"t_ms":7}`
		}
		body := []byte(fmt.Sprintf(`{"v":1,"id":%q,"op":%q,"params":%s}`, id, op, params))
		payload, err := aead.Seal(c2s, s.routeID, body)
		if err != nil {
			t.Fatal(err)
		}
		engine.handleSessFWD(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload}, s)
	}
	read := func() map[string]any {
		t.Helper()
		frame, ok := peer.RecvTimeout(2 * time.Second)
		if !ok {
			t.Fatal("no reply")
		}
		data, err := aead.Open(s2c, s.routeID, frame.Payload)
		if err != nil {
			t.Fatal(err)
		}
		var reply map[string]any
		if err := json.Unmarshal(data, &reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	return engine, s, send, read
}

func TestHealthPingBypassesSlowRPCOnSameRoute(t *testing.T) {
	rt := &blockedDescribeRuntime{Fake: runtime.NewFake(), started: make(chan struct{}, 1), release: make(chan struct{})}
	e, s, send, read := pingSession(t, rt)
	normalDone, healthDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(normalDone); e.runSessionRPC(s) }()
	go func() { defer close(healthDone); e.runSessionPing(s) }()
	defer func() { close(rt.release); stopSessionRPC(s); <-normalDone; <-healthDone }()
	send("slow", "GetConfig")
	select {
	case <-rt.started:
	case <-time.After(time.Second):
		t.Fatal("slow RPC did not start")
	}
	send("health", "Ping")
	reply := read()
	if reply["id"] != "health" || reply["ok"] != true {
		t.Fatalf("health blocked: %v", reply)
	}
}

func TestHealthLaneBoundedAndRepliesKeepAEADOrder(t *testing.T) {
	e, s, send, read := pingSession(t, runtime.NewFake())
	// No health worker until after saturation: capacity is deterministic.
	for i := 0; i < sessionPingQueueSize; i++ {
		send(fmt.Sprintf("ping%d", i), "Ping")
	}
	send("overflow", "Ping")
	reply := read()
	if reply["ok"] != false || reply["error"].(map[string]any)["code"] != "backpressure" {
		t.Fatalf("overflow: %v", reply)
	}
	if len(s.pingQueue) != sessionPingQueueSize || len(s.rpcQueue) != 0 {
		t.Fatal("health admission escaped bounds")
	}
	normalDone, healthDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(normalDone); e.runSessionRPC(s) }()
	go func() { defer close(healthDone); e.runSessionPing(s) }()
	defer func() { stopSessionRPC(s); <-normalDone; <-healthDone }()
	send("config", "GetConfig")
	seen := map[string]bool{}
	for i := 0; i < sessionPingQueueSize+1; i++ {
		r := read()
		if r["ok"] != true {
			t.Fatalf("reply: %v", r)
		}
		seen[r["id"].(string)] = true
	}
	if len(seen) != sessionPingQueueSize+1 {
		t.Fatalf("missing/duplicate replies: %v", seen)
	}
}

func TestStoppedHealthLaneDoesNotDrainQueuedRequests(t *testing.T) {
	e, s, send, _ := pingSession(t, runtime.NewFake())
	send("pending", "Ping")
	stopSessionRPC(s)
	e.runSessionPing(s)
	if len(s.pingQueue) != 1 {
		t.Fatal("stopped health worker consumed a request")
	}
}

func TestHealthIngressRejectsUnauthenticatedPayload(t *testing.T) {
	e, s, _, _ := pingSession(t, runtime.NewFake())
	e.handleSessFWD(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: []byte(`{"v":1,"id":"forged","op":"Ping","params":{"t_ms":7}}`)}, s)
	if len(s.pingQueue) != 0 {
		t.Fatal("unauthenticated Ping entered health lane")
	}
}

func TestHealthReplyCannotEscapeRetiredEpoch(t *testing.T) {
	e, s, send, _ := pingSession(t, runtime.NewFake())
	wire := newFailNthConn(999)
	s.link = wire
	send("pending", "Ping")
	s.sendMu.Lock()
	done := make(chan struct{})
	go func() { defer close(done); e.runSessionPing(s) }()
	deadline := time.Now().Add(time.Second)
	for s.interactiveWait.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	waiting := s.interactiveWait.Load() > 0
	e.mu.Lock()
	delete(e.sessions, s.routeID)
	s.state = "closed"
	e.mu.Unlock()
	stopSessionRPC(s)
	s.sendMu.Unlock()
	<-done
	if !waiting {
		t.Fatal("health worker did not reach send lock")
	}
	wire.mu.Lock()
	sends := wire.sends
	wire.mu.Unlock()
	if sends != 0 {
		t.Fatal("retired epoch sent a health response")
	}
}

func TestHealthAuditConcurrentWithTransportCommit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "health.jsonl")
	logger, err := audit.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	for i := 0; i < 20; i++ {
		e, s, send, _ := pingSession(t, runtime.NewFake())
		e.Audit = logger
		newRoute := [16]byte{2}
		key := randomTestBytes(t, 32)
		direct, _ := mux.NewPipePair(16)
		candidate := &sess{routeID: newRoute, state: "upgrade_ready", transport: "p2p", link: direct,
			upgradeFrom: s.routeID, attemptID: "p2p_0123456789abcdef",
			c2s: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirClient},
			s2c: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer}, rpcStop: make(chan struct{}),
		}
		e.sessions[newRoute] = candidate
		send("health", "Ping")
		// Admit Ping before racing the commit; otherwise stopping the worker
		// can skip every request and the audit branch is never exercised.
		s.sendMu.Lock()
		done := make(chan struct{})
		go func() { defer close(done); e.runSessionPing(s) }()
		deadline := time.Now().Add(2 * time.Second)
		for s.interactiveWait.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		waiting := s.interactiveWait.Load() > 0
		s.sendMu.Unlock()
		if !waiting {
			stopSessionRPC(s)
			<-done
			t.Fatal("health worker did not reach send lock")
		}
		params, _ := json.Marshal(transportCommitParams{AttemptID: candidate.attemptID, RouteID: hex.EncodeToString(newRoute[:])})
		e.rpcTransportCommit(s, "commit", params)
		stopSessionRPC(s)
		<-done
		e.mu.Lock()
		committed := s.routeID == newRoute
		e.mu.Unlock()
		if !committed {
			t.Fatal("transport commit failed")
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(path)
		if strings.Contains(string(data), `"op":"health_ping"`) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("health audit branch was not exercised")
}
