package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"

	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

func TestOpenPairingV2WaitsForAckLoc(t *testing.T) {
	a, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.MuxProtocol = 2
	eng.PairOpenAckWait = 20 * time.Second

	type result struct {
		st  PairingStatus
		err error
	}
	done := make(chan result, 1)
	go func() {
		st, err := eng.OpenPairing("ABCDEFGH")
		done <- result{st, err}
	}()

	frame, ok := peer.RecvTimeout(20 * time.Second)
	if !ok || frame.Typ != envelope.TypPAIR_OPEN {
		t.Fatalf("PAIR_OPEN frame=%v ok=%t", frame, ok)
	}
	var body struct {
		V       int    `json:"v"`
		Op      string `json:"op"`
		PairRef string `json:"pair_ref"`
		PairLoc string `json:"pair_loc"`
	}
	if err := json.Unmarshal(frame.Payload, &body); err != nil {
		t.Fatal(err)
	}
	if body.V != 2 || body.Op != "CreatePairing" || body.PairRef == "" || body.PairLoc != "" {
		t.Fatalf("PAIR_OPEN payload=%+v", body)
	}
	eng.Handle(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 2, "op": "CreatePairing", "ok": true,
		"pair_ref": body.PairRef, "pair_loc": "WJ3K9M", "ttl_s": 180,
	}))

	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.st.Loc != "WJ3K9M" || !strings.Contains(got.st.URL, "loc=WJ3K9M") || !strings.Contains(got.st.URL, "v=2") {
		t.Fatalf("status=%+v", got.st)
	}
	st := eng.PairingStatus()
	if st.Loc != "WJ3K9M" || st.Ref != body.PairRef {
		t.Fatalf("PairingStatus=%+v", st)
	}
}

func TestOpenPairingV2MissingAckTimesOut(t *testing.T) {
	a, peer := mux.NewPipePair(8)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	eng.MuxProtocol = 2
	eng.PairOpenAckWait = 40 * time.Millisecond
	_, err := eng.OpenPairing("ABCDEFGH")
	if err == nil || !strings.Contains(err.Error(), "pair_open_timeout") {
		t.Fatalf("got %v", err)
	}
	if eng.PairingStatus().Ref != "" {
		t.Fatal("timed-out PAIR_OPEN left a slot")
	}
	_, _ = peer.RecvTimeout(10 * time.Millisecond)
}

func TestOpenPairingV2IndexUnavailableFailsOpen(t *testing.T) {
	a, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	eng.MuxProtocol = 2
	eng.PairOpenAckWait = 20 * time.Second
	done := make(chan error, 1)
	go func() {
		_, err := eng.OpenPairing("ABCDEFGH")
		done <- err
	}()
	opened, ok := peer.RecvTimeout(20 * time.Second)
	if !ok {
		t.Fatal("missing PAIR_OPEN")
	}
	var openBody struct {
		PairRef string `json:"pair_ref"`
	}
	if json.Unmarshal(opened.Payload, &openBody) != nil || openBody.PairRef == "" {
		t.Fatalf("bad PAIR_OPEN payload %s", opened.Payload)
	}
	eng.Handle(envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{
		Code: "index_unavailable", PairRef: openBody.PairRef, Message: "pairing index unavailable",
	}))
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "index_unavailable") {
		t.Fatalf("got %v", err)
	}
	if eng.PairingStatus().Ref != "" {
		t.Fatal("index_unavailable left a slot")
	}
}

func TestOpenPairingV2SerializesRequestsAndIgnoresStaleFailure(t *testing.T) {
	a, peer := mux.NewPipePair(32)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.MuxProtocol = 2
	eng.PairOpenAckWait = 20 * time.Second
	type result struct {
		st  PairingStatus
		err error
	}
	firstDone := make(chan result, 1)
	secondDone := make(chan result, 1)
	go func() {
		st, err := eng.OpenPairing("ABCDEFGH")
		firstDone <- result{st: st, err: err}
	}()
	firstOpen, ok := peer.RecvTimeout(20 * time.Second)
	if !ok || firstOpen.Typ != envelope.TypPAIR_OPEN {
		t.Fatalf("first PAIR_OPEN frame=%v ok=%t", firstOpen, ok)
	}
	var firstBody struct {
		PairRef string `json:"pair_ref"`
	}
	if json.Unmarshal(firstOpen.Payload, &firstBody) != nil || firstBody.PairRef == "" {
		t.Fatalf("first payload=%s", firstOpen.Payload)
	}

	go func() {
		st, err := eng.OpenPairing("BCDEFGHJ")
		secondDone <- result{st: st, err: err}
	}()
	if frame, ok := peer.RecvTimeout(30 * time.Millisecond); ok {
		t.Fatalf("second request emitted before first ack: %+v", frame)
	}
	eng.Handle(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 2, "op": "CreatePairing", "ok": true,
		"pair_ref": firstBody.PairRef, "pair_loc": "WJ3K9M", "ttl_s": 180,
	}))
	if first := <-firstDone; first.err != nil {
		t.Fatal(first.err)
	}

	secondRef := ""
	for i := 0; i < 3 && secondRef == ""; i++ {
		frame, ok := peer.RecvTimeout(20 * time.Second)
		if !ok {
			t.Fatal("missing serialized second PAIR_OPEN")
		}
		if frame.Typ != envelope.TypPAIR_OPEN {
			continue
		}
		var body struct {
			PairRef string `json:"pair_ref"`
		}
		if json.Unmarshal(frame.Payload, &body) == nil {
			secondRef = body.PairRef
		}
	}
	if secondRef == "" || secondRef == firstBody.PairRef {
		t.Fatalf("second pair_ref=%q first=%q", secondRef, firstBody.PairRef)
	}
	eng.Handle(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 2, "op": "CreatePairing", "ok": true,
		"pair_ref": secondRef, "pair_loc": "ZXCVBN", "ttl_s": 180,
	}))
	if second := <-secondDone; second.err != nil {
		t.Fatal(second.err)
	}

	eng.Handle(envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{
		Code: "index_unavailable", PairRef: firstBody.PairRef, Message: "stale failure",
	}))
	if got := eng.PairingStatus().Ref; got != secondRef {
		t.Fatalf("stale failure burned current pair: got=%q want=%q", got, secondRef)
	}
}

func TestRegistrationFrameV2OmitsJoinToken(t *testing.T) {
	a, _ := mux.NewPipePair(4)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.MuxProtocol = 2
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.Reconnect = "rt_" + strings.Repeat("ab", 16)
	frame := eng.registrationFrame("pf_should_not_appear")
	var body map[string]any
	if err := json.Unmarshal(frame.Payload, &body); err != nil {
		t.Fatal(err)
	}
	if body["v"] != float64(2) || body["protocol"] != float64(2) {
		t.Fatalf("HELLO_DAEMON payload=%v", body)
	}
	if _, ok := body["join_token"]; ok {
		t.Fatal("v2 HELLO_DAEMON included join_token")
	}
	if body["reconnect_token"] != eng.Reconnect || body["daemon_id"] != eng.DaemonID {
		t.Fatalf("reconnect fields=%v", body)
	}
}

func TestMuxV2PairAttachedAndCloseUseV2(t *testing.T) {
	a, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.MuxProtocol = 2
	eng.PairOpenAckWait = 20 * time.Second

	type result struct {
		st  PairingStatus
		err error
	}
	done := make(chan result, 1)
	go func() {
		st, err := eng.OpenPairing("ABCDEFGH")
		done <- result{st: st, err: err}
	}()

	opened, ok := peer.RecvTimeout(20 * time.Second)
	if !ok || opened.Typ != envelope.TypPAIR_OPEN {
		t.Fatalf("PAIR_OPEN frame=%v ok=%t", opened, ok)
	}
	var openBody struct {
		PairRef string `json:"pair_ref"`
	}
	if json.Unmarshal(opened.Payload, &openBody) != nil || openBody.PairRef == "" {
		t.Fatalf("PAIR_OPEN payload=%s", opened.Payload)
	}
	eng.Handle(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 2, "op": "CreatePairing", "ok": true,
		"pair_ref": openBody.PairRef, "pair_loc": "WJ3K9M", "ttl_s": 180,
	}))
	got := <-done
	if got.err != nil {
		t.Fatal(got.err)
	}

	rid := [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	eng.Handle(envelope.JSON(envelope.TypPAIR_ATTACHED, rid, map[string]any{
		"v": 2, "attempt_id": "attempt-v2", "route_id": hex.EncodeToString(rid[:]),
	}))
	eng.mu.Lock()
	attached := eng.pair != nil && eng.pair.routeID == rid && eng.pair.attempt == "attempt-v2"
	eng.mu.Unlock()
	if !attached {
		t.Fatal("v2 PAIR_ATTACHED was not accepted")
	}

	if err := eng.Deny(got.st.Ref); err != nil {
		t.Fatal(err)
	}
	closed, ok := peer.RecvTimeout(time.Second)
	if !ok || closed.Typ != envelope.TypPAIR_CLOSE {
		t.Fatalf("PAIR_CLOSE frame=%v ok=%t", closed, ok)
	}
	var closeBody struct {
		V       int    `json:"v"`
		PairRef string `json:"pair_ref"`
	}
	if json.Unmarshal(closed.Payload, &closeBody) != nil || closeBody.V != 2 || closeBody.PairRef != got.st.Ref {
		t.Fatalf("PAIR_CLOSE payload=%s", closed.Payload)
	}
}

func TestMuxV2SessionBoundAndEstablishedUseV2(t *testing.T) {
	a, peer := mux.NewPipePair(16)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.MuxProtocol = 2
	deviceID := "dev_v2"
	psk := make([]byte, 32)
	if _, err := rand.Read(psk); err != nil {
		t.Fatal(err)
	}
	eng.PutDevice(deviceID, psk)

	rid := [16]byte{16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1}
	eng.Handle(envelope.JSON(envelope.TypSESSION_BOUND, rid, map[string]any{
		"v": 2, "route_id": hex.EncodeToString(rid[:]),
	}))
	s := eng.Session(rid)
	if s == nil {
		t.Fatal("v2 SESSION_BOUND was not accepted")
	}

	var phoneSK, phonePK, daemonSK, daemonPK [32]byte
	if _, err := rand.Read(phoneSK[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := rand.Read(daemonSK[:]); err != nil {
		t.Fatal(err)
	}
	curve25519.ScalarBaseMult(&phonePK, &phoneSK)
	curve25519.ScalarBaseMult(&daemonPK, &daemonSK)
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Unix()
	eng.mu.Lock()
	s.deviceID = deviceID
	s.peerPk = phonePK
	s.ephSk = daemonSK
	s.ephPk = daemonPK
	s.nonce = nonce
	s.ts = ts
	s.state = "hello2"
	eng.mu.Unlock()
	td := sessionkeys.TranscriptD(eng.DaemonID, deviceID, phonePK[:], daemonPK[:], nonce, ts, rid)
	proof := sessionkeys.Proof(psk, sessionkeys.TranscriptP(td))
	if !eng.FinishHello3(s, proof, ts) {
		t.Fatal("FinishHello3 failed")
	}
	defer eng.ResetTransport()

	established, ok := peer.RecvTimeout(time.Second)
	if !ok || established.Typ != envelope.TypSESSION_ESTABLISHED {
		t.Fatalf("SESSION_ESTABLISHED frame=%v ok=%t", established, ok)
	}
	var body struct {
		V       int    `json:"v"`
		RouteID string `json:"route_id"`
	}
	if json.Unmarshal(established.Payload, &body) != nil || body.V != 2 || body.RouteID != hex.EncodeToString(rid[:]) {
		t.Fatalf("SESSION_ESTABLISHED payload=%s", established.Payload)
	}
}

func TestOpenPairingV1DoesNotWaitForAck(t *testing.T) {
	a, peer := mux.NewPipePair(8)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	st, err := eng.OpenPairing("ABCDEFGH")
	if err != nil {
		t.Fatal(err)
	}
	if st.Ref == "" || st.Loc != "" || strings.Contains(st.URL, "v=2") {
		t.Fatalf("v1 status=%+v", st)
	}
	frame, ok := peer.RecvTimeout(time.Second)
	if !ok || frame.Typ != envelope.TypPAIR_OPEN {
		t.Fatal("v1 PAIR_OPEN was not sent")
	}
	var body struct {
		V int `json:"v"`
	}
	if json.Unmarshal(frame.Payload, &body) != nil || body.V != 1 {
		t.Fatalf("v1 PAIR_OPEN v=%d", body.V)
	}
}
