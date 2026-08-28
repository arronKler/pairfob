package daemon

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

type submitFailRuntime struct{ *runtime.Fake }

func (r *submitFailRuntime) Execute(ctx context.Context, session runtime.SessionRef, operationID string, command runtime.Command) (runtime.Receipt, error) {
	if _, ok := command.(runtime.SendKeysCommand); ok {
		err := errors.New("send enter failed")
		return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeNotApplied}, &runtime.Fault{Code: runtime.CodeInternal, Outcome: runtime.OutcomeNotApplied, Retry: runtime.RetryNever, SafeMessage: err.Error(), Cause: err}
	}
	return r.Fake.Execute(ctx, session, operationID, command)
}

func TestPairCodeAndLocalAuthorizationGates(t *testing.T) {
	a, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	offer, err := eng.OpenPairing("")
	if err != nil {
		t.Fatal(err)
	}
	ref := offer.Ref
	st := eng.PairingStatus()
	if len(ref) != 32 || len(st.Code) != 8 || st.URL == "" {
		t.Fatalf("bad generated pairing status: %+v", st)
	}
	if err := eng.Admit(ref); err != nil {
		t.Fatalf("active slot should allow approval before phone handshake: %v", err)
	}
	if !eng.PairingStatus().Admitted {
		t.Fatal("active pairing slot did not retain local approval")
	}
	if err := eng.Deny(strings.Repeat("0", 32)); err == nil {
		t.Fatal("wrong pair_ref denied active slot")
	}
	if err := eng.Deny(ref); err != nil {
		t.Fatal(err)
	}
	if eng.PairingStatus().Ref != "" {
		t.Fatal("deny did not burn pairing slot")
	}
	for _, bad := range []string{"SHORT", "012345678", "ABCDE*GH"} {
		if _, err := eng.OpenPairing(bad); err == nil {
			t.Fatalf("invalid pairing code %q accepted", bad)
		}
	}
}

func TestRelayReplacementBurnsOnlyTheMatchingPairing(t *testing.T) {
	a, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	offer, err := eng.OpenPairing("ABCDEFGH")
	if err != nil {
		t.Fatal(err)
	}
	eng.Handle(envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{
		Code: "pairing_replaced", PairRef: strings.Repeat("0", 32), Message: "stale notification",
	}))
	if eng.PairingStatus().Ref != offer.Ref {
		t.Fatal("stale relay notification burned the active pairing")
	}
	eng.Handle(envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{
		Code: "pairing_replaced", PairRef: offer.Ref, Message: "newer pairing opened",
	}))
	if eng.PairingStatus().Ref != "" {
		t.Fatal("matching relay replacement did not burn the pairing")
	}
}

func TestDeviceLabelBoundary(t *testing.T) {
	for _, label := range []string{"", "iPhone", "Android 手机", strings.Repeat("a", maxDeviceLabelBytes)} {
		if !validDeviceLabel(label) {
			t.Fatalf("expected valid device label %q", label)
		}
	}
	for _, label := range []string{"phone\nadmin", strings.Repeat("a", maxDeviceLabelBytes+1), string([]byte{0xff})} {
		if validDeviceLabel(label) {
			t.Fatalf("expected invalid device label %q", label)
		}
	}
}

func TestRequestIDSchemaBoundary(t *testing.T) {
	if !validRequestID(strings.Repeat("a", 128)) || validRequestID(strings.Repeat("a", 129)) || !validID(strings.Repeat("p", 256)) {
		t.Fatal("request and pane ID limits are not independently schema-aligned")
	}
	if decodeStrictJSON([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, &map[string]string{}) == nil {
		t.Fatal("invalid UTF-8 JSON was accepted")
	}
}

func TestMalformedPairingAndHelloNeverPanic(t *testing.T) {
	a, peer := mux.NewPipePair(32)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	_, err := eng.OpenPairing("ABCDEFGH")
	if err != nil {
		t.Fatal(err)
	}
	ridBytes := make([]byte, 16)
	for i := range ridBytes {
		ridBytes[i] = byte(i + 1)
	}
	var rid [16]byte
	copy(rid[:], ridBytes)
	eng.Handle(envelope.JSON(envelope.TypPAIR_ATTACHED, rid, map[string]any{
		"v": 1, "attempt_id": "at_test", "route_id": hex.EncodeToString(rid[:]),
	}))
	for i := 0; i < 3; i++ {
		eng.Handle(envelope.JSON(envelope.TypFWD, rid, map[string]any{"v": 1, "op": "SpakeShareP", "share": "***"}))
	}
	if eng.PairingStatus().Ref != "" {
		t.Fatal("third malformed SPAKE message did not burn slot")
	}
	_ = peer

	psk := make([]byte, 32)
	eng.PutDevice("dev_12345678", psk)
	eng.Handle(envelope.JSON(envelope.TypSESSION_BOUND, rid, map[string]any{"v": 1, "route_id": hex.EncodeToString(rid[:])}))
	eng.Handle(envelope.JSON(envelope.TypFWD, rid, map[string]any{
		"v": 1, "op": "DeviceHello1", "device_id": "dev_12345678", "daemon_id": eng.DaemonID,
		"eph_x25519": "***", "nonce": "***",
	}))
	if eng.Session(rid) != nil {
		t.Fatal("malformed DeviceHello session was not cleaned")
	}
}

func TestResetTransportWipesSessionsAndBurnsInFlightPair(t *testing.T) {
	a, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	rid := [16]byte{1}
	key := make([]byte, 32)
	for i := range key {
		key[i] = 7
	}
	s := &sess{routeID: rid, deviceID: "dev_12345678", state: "established", c2s: &aead.Direction{Key: key}, s2c: &aead.Direction{Key: append([]byte(nil), key...)}}
	eng.mu.Lock()
	eng.sessions[rid] = s
	eng.byDevice[s.deviceID] = rid
	eng.pair = &pairingSlot{ref: strings.Repeat("a", 32), confirmVerified: true, admitCh: make(chan struct{})}
	eng.mu.Unlock()
	if !eng.ResetTransport() {
		t.Fatal("in-flight pairing should require rotation")
	}
	if eng.Session(rid) != nil || eng.PairingStatus().Ref != "" {
		t.Fatal("transport-scoped state survived reset")
	}
	for _, b := range key {
		if b != 0 {
			t.Fatal("session key was not wiped")
		}
	}
}

func TestPokeUsesSessionAEADAndProtocolShape(t *testing.T) {
	engineSide, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, engineSide, runtime.NewFake())
	rid := [16]byte{9}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	s := &sess{routeID: rid, deviceID: "dev_12345678", state: "established", s2c: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer}}
	eng.mu.Lock()
	eng.sessions[rid] = s
	eng.mu.Unlock()
	eng.sendPoke("agent_status", "w0:p1")
	frame, ok := peer.RecvTimeout(5 * time.Second)
	if !ok || frame.Typ != envelope.TypFWD {
		t.Fatalf("poke frame ok=%v typ=%d", ok, frame.Typ)
	}
	plain, err := aead.Open(&aead.Direction{Key: key, Dir: aead.DirServer}, rid, frame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var poke struct {
		V      int    `json:"v"`
		ID     string `json:"id"`
		Op     string `json:"op"`
		Params struct {
			Reason string `json:"reason"`
			PaneID string `json:"pane_id"`
		} `json:"params"`
	}
	if json.Unmarshal(plain, &poke) != nil || poke.V != 1 || poke.ID != "" || poke.Op != "Poke" || poke.Params.Reason != "agent_status" || poke.Params.PaneID != "w0:p1" {
		t.Fatalf("bad poke: %s", plain)
	}
}

func TestSendTextSubmitPropagatesEnterFailure(t *testing.T) {
	engineSide, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, engineSide, &submitFailRuntime{Fake: runtime.NewFake()})
	rid := [16]byte{7}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 3)
	}
	s := &sess{routeID: rid, deviceID: "dev_12345678", state: "established", s2c: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer}}
	eng.mu.Lock()
	eng.sessions[rid] = s
	eng.mu.Unlock()
	eng.dispatch(s, "req_submit", "SendText", json.RawMessage(`{"operation_id":"op_CAECAwQFBgcICQoL","pane_id":"w0:p1","text":"hello","submit":true}`))
	frame, ok := peer.RecvTimeout(5 * time.Second)
	if !ok {
		t.Fatal("missing SendText error reply")
	}
	plain, err := aead.Open(&aead.Direction{Key: key, Dir: aead.DirServer}, rid, frame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(plain, &response) != nil || response.OK || response.Error.Code == "" {
		t.Fatalf("submit failure was reported as success: %s", plain)
	}
}

func TestConcurrentPokeAndReplyPreserveAEADWireOrder(t *testing.T) {
	engineSide, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, engineSide, runtime.NewFake())
	rid := [16]byte{6}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(100 + i)
	}
	s := &sess{routeID: rid, deviceID: "dev_12345678", state: "established", s2c: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer}}
	eng.mu.Lock()
	eng.sessions[rid] = s
	eng.mu.Unlock()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); eng.sendPoke("agent_status", "w0:p1") }()
	go func() { defer wg.Done(); eng.reply(s, "req_concurrent", map[string]any{"ok": true}) }()
	wg.Wait()
	receiver := &aead.Direction{Key: key, Dir: aead.DirServer}
	for i := 0; i < 2; i++ {
		frame, ok := peer.RecvTimeout(time.Second)
		if !ok {
			t.Fatalf("missing frame %d", i)
		}
		if _, err := aead.Open(receiver, rid, frame.Payload); err != nil {
			t.Fatalf("frame %d out of AEAD order: %v", i, err)
		}
	}
}

func TestRevokePersistenceFailureIsInternalAndKeepsSession(t *testing.T) {
	engineSide, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, engineSide, runtime.NewFake())
	deviceID := "dev_12345678"
	eng.PutDevice(deviceID, make([]byte, 32))
	eng.Store = &state.Store{Dir: filepath.Join(t.TempDir(), "missing")}
	rid := [16]byte{8}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(40 + i)
	}
	s := &sess{routeID: rid, deviceID: deviceID, state: "established", s2c: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer}}
	eng.mu.Lock()
	eng.sessions[rid] = s
	eng.byDevice[deviceID] = rid
	eng.mu.Unlock()
	eng.dispatch(s, "req_revoke", "RevokeDevice", json.RawMessage(`{"operation_id":"op_CQECAwQFBgcICQoL","device_id":"dev_12345678"}`))
	frame, ok := peer.RecvTimeout(time.Second)
	if !ok {
		t.Fatal("missing revoke failure response")
	}
	plain, err := aead.Open(&aead.Direction{Key: key, Dir: aead.DirServer}, rid, frame.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(plain, &response) != nil || response.OK || response.Error.Code != "internal" {
		t.Fatalf("unexpected revoke failure: %s", plain)
	}
	eng.mu.Lock()
	dev := eng.Devices[deviceID]
	stillActive := eng.sessions[rid] == s
	eng.mu.Unlock()
	if dev == nil || dev.RevokedAt != nil || !stillActive {
		t.Fatal("failed persistence mutated revocation or closed the active session")
	}
}

func TestSelfRevokeClosesTakeoverRouteWhenReplyIsLost(t *testing.T) {
	engineSide, _ := mux.NewPipePair(16)
	eng := NewEngine(nil, engineSide, runtime.NewFake())
	store, err := state.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	eng.Store = store
	deviceID := "dev_12345678"
	eng.PutDevice(deviceID, make([]byte, 32))

	oldRoute := [16]byte{8}
	oldKey := make([]byte, 32)
	for i := range oldKey {
		oldKey[i] = byte(40 + i)
	}
	oldSession := &sess{
		routeID: oldRoute, deviceID: deviceID, state: "established",
		s2c: &aead.Direction{Key: append([]byte(nil), oldKey...), Dir: aead.DirServer},
	}
	eng.mu.Lock()
	eng.sessions[oldRoute] = oldSession
	eng.byDevice[deviceID] = oldRoute
	eng.mu.Unlock()

	// Hold revocation before its device-state update. This lets a new route take
	// over first, while the old route's durable mutation is already in flight.
	eng.mu.Lock()
	engineUnlocked := false
	defer func() {
		if !engineUnlocked {
			eng.mu.Unlock()
		}
	}()
	const operationID = "op_CgECAwQFBgcICQoL"
	dispatchDone := make(chan struct{})
	go func() {
		defer close(dispatchDone)
		eng.dispatch(oldSession, "req_revoke", "RevokeDevice", json.RawMessage(`{"operation_id":"`+operationID+`","device_id":"`+deviceID+`"}`))
	}()

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	var mutationDone <-chan struct{}
	for mutationDone == nil {
		eng.operationMu.Lock()
		if record := eng.operations[deviceID+"\x00"+operationID]; record != nil {
			mutationDone = record.done
		}
		eng.operationMu.Unlock()
		if mutationDone != nil {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("revoke mutation was not recorded")
		case <-time.After(time.Millisecond):
		}
	}

	newRoute := [16]byte{9}
	newSession := &sess{
		routeID: newRoute, deviceID: deviceID, state: "established",
		s2c: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirServer},
	}
	oldSession.state = "closed"
	delete(eng.sessions, oldRoute)
	eng.sessions[newRoute] = newSession
	eng.byDevice[deviceID] = newRoute
	eng.mu.Unlock()
	engineUnlocked = true

	select {
	case <-mutationDone:
	case <-deadline.C:
		t.Fatal("revoke mutation did not finish persistence")
	}

	eng.mu.Lock()
	device := eng.Devices[deviceID]
	revoked := device != nil && device.RevokedAt != nil
	eng.mu.Unlock()
	if !revoked {
		t.Fatal("revoke mutation completed without persisting device revocation")
	}

	select {
	case <-dispatchDone:
	case <-time.After(5 * time.Second):
		t.Fatal("self-revoke dispatch did not finish")
	}

	eng.mu.Lock()
	_, newRouteActive := eng.sessions[newRoute]
	_, deviceRouteActive := eng.byDevice[deviceID]
	newRouteState := newSession.state
	eng.mu.Unlock()
	if newRouteActive || deviceRouteActive || newRouteState != "closed" {
		t.Fatalf("persisted revoke left takeover route active: route=%v device=%v state=%q", newRouteActive, deviceRouteActive, newRouteState)
	}
}
