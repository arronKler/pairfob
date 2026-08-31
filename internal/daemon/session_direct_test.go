package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

type blockingDirectAcceptor struct {
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (a *blockingDirectAcceptor) Accept(
	context.Context,
	string,
	func(mux.Conn, envelope.Frame),
	func(mux.Conn),
) (string, mux.Conn, error) {
	a.calls.Add(1)
	close(a.entered)
	<-a.release
	return "", nil, errors.New("test negotiation stopped")
}

func TestTransportOfferAllowsOneNegotiationPerRelaySession(t *testing.T) {
	relayLink, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, relayLink, runtime.NewFake())
	route := [16]byte{9}
	parent := &sess{
		routeID: route, deviceID: "dev_direct", state: "established", transport: "relay", link: relayLink,
		c2s: &aead.Direction{Key: randomTestBytes(t, 32), Dir: aead.DirClient},
		s2c: &aead.Direction{Key: randomTestBytes(t, 32), Dir: aead.DirServer},
	}
	acceptor := &blockingDirectAcceptor{entered: make(chan struct{}), release: make(chan struct{})}
	eng.Direct = acceptor
	eng.mu.Lock()
	eng.sessions[route] = parent
	eng.byDevice[parent.deviceID] = route
	eng.mu.Unlock()
	params := json.RawMessage(`{"attempt_id":"p2p_0123456789abcdef","sdp":"v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"}`)
	done := make(chan struct{})
	go func() {
		eng.rpcTransportOffer(parent, "first", params)
		close(done)
	}()
	select {
	case <-acceptor.entered:
	case <-time.After(time.Second):
		t.Fatal("first negotiation did not start")
	}
	eng.rpcTransportOffer(parent, "second", params)
	close(acceptor.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("first negotiation did not finish")
	}
	if got := acceptor.calls.Load(); got != 1 {
		t.Fatalf("Accept calls = %d, want 1", got)
	}
}

func TestDirectHelloBuildsFreshEpochWithoutReplacingRelay(t *testing.T) {
	relayLink, _ := mux.NewPipePair(16)
	directLink, directPeer := mux.NewPipePair(16)
	eng := NewEngine(nil, relayLink, runtime.NewFake())
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.MuxProtocol = 2
	deviceID := "dev_direct"
	psk := randomTestBytes(t, 32)
	eng.PutDevice(deviceID, psk)

	parentRoute := [16]byte{1}
	parentKey := randomTestBytes(t, 32)
	parent := &sess{
		routeID: parentRoute, deviceID: deviceID, state: "established", transport: "relay", link: relayLink,
		c2s: &aead.Direction{Key: append([]byte(nil), parentKey...), Dir: aead.DirClient},
		s2c: &aead.Direction{Key: append([]byte(nil), parentKey...), Dir: aead.DirServer},
	}
	directRoute := [16]byte{2}
	candidate := &sess{
		routeID: directRoute, deviceID: deviceID, state: "hello2", transport: "p2p", link: directLink,
		upgradeFrom: parentRoute, attemptID: "p2p_0123456789abcdef",
		rpcStop: make(chan struct{}), rpcQueue: make(chan rpcRequest, 1),
	}
	var phoneSK, phonePK, daemonSK, daemonPK [32]byte
	copy(phoneSK[:], randomTestBytes(t, 32))
	copy(daemonSK[:], randomTestBytes(t, 32))
	curve25519.ScalarBaseMult(&phonePK, &phoneSK)
	curve25519.ScalarBaseMult(&daemonPK, &daemonSK)
	candidate.peerPk, candidate.ephSk, candidate.ephPk = phonePK, daemonSK, daemonPK
	candidate.nonce = randomTestBytes(t, 16)
	candidate.ts = time.Now().Unix()

	eng.mu.Lock()
	eng.sessions[parentRoute] = parent
	eng.sessions[directRoute] = candidate
	eng.byDevice[deviceID] = parentRoute
	eng.mu.Unlock()
	transcript := sessionkeys.TranscriptD(eng.DaemonID, deviceID, phonePK[:], daemonPK[:], candidate.nonce, candidate.ts, directRoute)
	proof := sessionkeys.Proof(psk, sessionkeys.TranscriptP(transcript))
	if !eng.FinishHello3(candidate, proof, candidate.ts) {
		t.Fatal("direct DeviceHello3 failed")
	}
	if candidate.state != "upgrade_ready" || candidate.c2s == nil || candidate.s2c == nil {
		t.Fatalf("candidate state=%q c2s=%v s2c=%v", candidate.state, candidate.c2s != nil, candidate.s2c != nil)
	}
	if eng.Session(parentRoute) != parent || eng.byDevice[deviceID] != parentRoute || parent.state != "established" {
		t.Fatal("direct handshake replaced the active relay session before commit")
	}
	if string(candidate.c2s.Key) == string(parentKey) {
		t.Fatal("direct handshake reused the relay key epoch")
	}
	established, ok := directPeer.RecvTimeout(time.Second)
	if !ok || established.Typ != envelope.TypSESSION_ESTABLISHED || established.RouteID != directRoute {
		t.Fatalf("direct establishment frame=%+v ok=%t", established, ok)
	}
}

func TestTransportCommitAtomicallyMovesLogicalSessionAndTerminal(t *testing.T) {
	relayLink, relayPeer := mux.NewPipePair(16)
	directLink, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, relayLink, runtime.NewFake())
	oldRoute := [16]byte{3}
	newRoute := [16]byte{4}
	deviceID := "dev_direct"
	oldKey := randomTestBytes(t, 32)
	newC2S := randomTestBytes(t, 32)
	newS2C := randomTestBytes(t, 32)
	terminal := &terminalSlot{id: "term_existing", paneID: "pane_1"}
	parent := &sess{
		routeID: oldRoute, deviceID: deviceID, state: "established", transport: "relay", link: relayLink,
		c2s: &aead.Direction{Key: randomTestBytes(t, 32), Dir: aead.DirClient},
		s2c: &aead.Direction{Key: append([]byte(nil), oldKey...), Dir: aead.DirServer}, terminal: terminal,
	}
	oldParentS2C := parent.s2c
	attempt := "p2p_0123456789abcdef"
	candidate := &sess{
		routeID: newRoute, deviceID: deviceID, state: "upgrade_ready", transport: "p2p", link: directLink,
		upgradeFrom: oldRoute, attemptID: attempt,
		c2s:     &aead.Direction{Key: append([]byte(nil), newC2S...), Dir: aead.DirClient},
		s2c:     &aead.Direction{Key: append([]byte(nil), newS2C...), Dir: aead.DirServer},
		rpcStop: make(chan struct{}), rpcQueue: make(chan rpcRequest, 1),
	}
	eng.mu.Lock()
	eng.sessions[oldRoute] = parent
	eng.sessions[newRoute] = candidate
	eng.byDevice[deviceID] = oldRoute
	eng.mu.Unlock()
	params, _ := json.Marshal(transportCommitParams{AttemptID: attempt, RouteID: hex.EncodeToString(newRoute[:])})
	eng.rpcTransportCommit(parent, "req_commit", params)

	reply, ok := relayPeer.RecvTimeout(time.Second)
	if !ok {
		t.Fatal("commit reply was not sent on the relay")
	}
	plain, err := aead.Open(&aead.Direction{Key: oldKey, Dir: aead.DirServer}, oldRoute, reply.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		OK     bool   `json:"ok"`
		ID     string `json:"id"`
		Result struct {
			Transport string `json:"transport"`
		} `json:"result"`
	}
	if json.Unmarshal(plain, &response) != nil || !response.OK || response.ID != "req_commit" || response.Result.Transport != "webrtc" {
		t.Fatalf("commit response=%s", plain)
	}
	if eng.Session(oldRoute) != nil || eng.Session(newRoute) != parent || eng.byDevice[deviceID] != newRoute {
		t.Fatal("session maps were not atomically moved to the direct route")
	}
	if parent.transport != "p2p" || parent.link != directLink || parent.terminal != terminal {
		t.Fatal("logical session or terminal was not preserved across commit")
	}
	if string(parent.c2s.Key) != string(newC2S) || string(parent.s2c.Key) != string(newS2C) {
		t.Fatal("fresh direct key epoch was not installed")
	}
	for _, value := range oldParentS2C.Key {
		if value != 0 {
			t.Fatal("relay key epoch was not wiped after commit")
		}
	}
	if candidate.link != nil || candidate.c2s != nil || candidate.s2c != nil || candidate.state != "closed" {
		t.Fatal("candidate still owns committed transport state")
	}
}

func TestResetTransportKeepsOnlyEstablishedP2P(t *testing.T) {
	relayLink, _ := mux.NewPipePair(16)
	directLink, _ := mux.NewPipePair(16)
	candidateLink, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, relayLink, runtime.NewFake())
	relayRoute, directRoute, candidateRoute := [16]byte{5}, [16]byte{6}, [16]byte{7}
	relayKey, directKey := randomTestBytes(t, 32), randomTestBytes(t, 32)
	relay := &sess{routeID: relayRoute, deviceID: "dev_relay", state: "established", transport: "relay", link: relayLink,
		c2s: &aead.Direction{Key: relayKey}, s2c: &aead.Direction{Key: append([]byte(nil), relayKey...)}}
	direct := &sess{routeID: directRoute, deviceID: "dev_direct", state: "established", transport: "p2p", link: directLink,
		c2s: &aead.Direction{Key: directKey}, s2c: &aead.Direction{Key: append([]byte(nil), directKey...)}}
	candidate := &sess{routeID: candidateRoute, deviceID: "dev_relay", state: "upgrade_ready", transport: "p2p", link: candidateLink,
		c2s: &aead.Direction{Key: randomTestBytes(t, 32)}, s2c: &aead.Direction{Key: randomTestBytes(t, 32)}, rpcStop: make(chan struct{})}
	eng.mu.Lock()
	eng.sessions[relayRoute], eng.sessions[directRoute], eng.sessions[candidateRoute] = relay, direct, candidate
	eng.byDevice[relay.deviceID], eng.byDevice[direct.deviceID] = relayRoute, directRoute
	eng.mu.Unlock()
	eng.ResetTransport()
	if eng.Session(relayRoute) != nil || eng.Session(candidateRoute) != nil || eng.Session(directRoute) != direct {
		t.Fatal("relay reset did not retain exactly the established P2P session")
	}
	if eng.byDevice[direct.deviceID] != directRoute || direct.state != "established" || direct.c2s == nil {
		t.Fatal("established P2P state was damaged by relay reset")
	}
	for _, value := range relayKey {
		if value != 0 {
			t.Fatal("relay key was not wiped")
		}
	}
}

func randomTestBytes(t *testing.T, size int) []byte {
	t.Helper()
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return value
}
