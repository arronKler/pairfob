package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"golang.org/x/crypto/curve25519"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/envelope"
)

type rpcRequest struct {
	id     string
	op     string
	params json.RawMessage
}

const sessionRPCQueueSize = 32

func (e *Engine) runSessionRPC(s *sess) {
	for {
		select {
		case request := <-s.rpcQueue:
			e.mu.Lock()
			active := s.state == "established" && e.sessions[s.routeID] == s
			e.mu.Unlock()
			if active {
				e.dispatch(s, request.id, request.op, request.params)
			}
		case <-s.rpcStop:
			return
		}
	}
}

func stopSessionRPC(s *sess) {
	if s != nil && s.rpcStop != nil {
		s.rpcStopOnce.Do(func() { close(s.rpcStop) })
	}
}

func (e *Engine) handleSessionBound(f envelope.Frame) {
	var body struct {
		V       int    `json:"v"`
		RouteID string `json:"route_id"`
	}
	if json.Unmarshal(f.Payload, &body) != nil || body.V != e.muxVersion() {
		return
	}
	raw, err := hex.DecodeString(body.RouteID)
	if err != nil || len(raw) != 16 {
		return
	}
	var rid [16]byte
	copy(rid[:], raw)
	if rid != f.RouteID {
		return
	}
	e.mu.Lock()
	old := e.sessions[rid]
	if old != nil {
		delete(e.sessions, rid)
		old.state = "closed"
	}
	created := &sess{
		routeID: rid, state: "resumehello", link: e.Conn, transport: "relay",
		rpcQueue: make(chan rpcRequest, sessionRPCQueueSize), rpcStop: make(chan struct{}),
	}
	e.sessions[rid] = created
	e.mu.Unlock()
	go e.runSessionRPC(created)
	if old != nil {
		stopSessionRPC(old)
		old.sendMu.Lock()
		e.wipeSession(old)
		old.sendMu.Unlock()
	}
}

func (e *Engine) handleSessFWD(f envelope.Frame, s *sess) {
	e.mu.Lock()
	stateNow := s.state
	e.mu.Unlock()
	if stateNow != "established" {
		e.handleHello(f, s)
		return
	}
	s.sendMu.Lock()
	if s.c2s == nil {
		s.sendMu.Unlock()
		e.closeSession(s.routeID, "unpaired", true)
		return
	}
	pt, err := aead.Open(s.c2s, s.routeID, f.Payload)
	s.sendMu.Unlock()
	if err != nil {
		e.closeSession(s.routeID, "unpaired", true)
		return
	}
	e.mu.Lock()
	active := s.state == "established" && e.sessions[s.routeID] == s
	e.mu.Unlock()
	if !active {
		return
	}
	var req struct {
		V      int             `json:"v"`
		ID     string          `json:"id"`
		Op     string          `json:"op"`
		Params json.RawMessage `json:"params"`
	}
	if decodeStrictJSON(pt, &req) != nil || req.V != 1 || !validRequestID(req.ID) || req.Op == "" || len(req.Op) > 64 || len(req.Params) == 0 {
		if validRequestID(req.ID) {
			e.replyErr(s, req.ID, "unknown_op", "invalid request")
		}
		return
	}
	request := rpcRequest{id: req.ID, op: req.Op, params: append(json.RawMessage(nil), req.Params...)}
	if s.rpcQueue == nil {
		// Explicitly embedded test sessions may bypass the normal handshake.
		e.dispatch(s, request.id, request.op, request.params)
		return
	}
	select {
	case s.rpcQueue <- request:
	default:
		e.replyErr(s, req.ID, "backpressure", "session request queue is full")
	}
}

func (e *Engine) allowHelloLocked(deviceID string, now time.Time) bool {
	cutoff := now.Add(-time.Minute)
	prune := func(in []time.Time) []time.Time {
		i := 0
		for i < len(in) && in[i].Before(cutoff) {
			i++
		}
		return append([]time.Time(nil), in[i:]...)
	}
	e.helloGlobal = prune(e.helloGlobal)
	perDevice := prune(e.helloByDevice[deviceID])
	if len(e.helloGlobal) >= 30 || len(perDevice) >= 10 {
		e.helloByDevice[deviceID] = perDevice
		return false
	}
	e.helloGlobal = append(e.helloGlobal, now)
	e.helloByDevice[deviceID] = append(perDevice, now)
	return true
}

func (e *Engine) rememberNonceLocked(deviceID string, nonce []byte) bool {
	key := string(nonce)
	for _, seen := range e.nonceByDevice[deviceID] {
		if seen == key {
			return false
		}
	}
	list := append(e.nonceByDevice[deviceID], key)
	if len(list) > 32 {
		list = append([]string(nil), list[len(list)-32:]...)
	}
	e.nonceByDevice[deviceID] = list
	return true
}

func helloErrorPayload(code string) []byte {
	errBody := &struct {
		Code string `json:"code"`
	}{Code: code}
	b, _ := json.Marshal(sessionkeys.Hello2{V: 1, Op: "DeviceHello2", OK: false, Error: errBody})
	return b
}

func (e *Engine) failHello(s *sess, code string) {
	_ = e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: helloErrorPayload(code)})
	e.closeSession(s.routeID, "", false)
	e.audit("session_hello_failed", map[string]any{"device_id": s.deviceID, "code": code})
}

func (e *Engine) handleHello(f envelope.Frame, s *sess) {
	var peek struct {
		V  int    `json:"v"`
		Op string `json:"op"`
	}
	if json.Unmarshal(f.Payload, &peek) != nil || peek.V != 1 {
		e.failHello(s, "unpaired")
		return
	}
	switch peek.Op {
	case "DeviceHello1":
		var h sessionkeys.Hello1
		if json.Unmarshal(f.Payload, &h) != nil || h.Op != "DeviceHello1" || h.DaemonID != e.DaemonID || h.DeviceID == "" || len(h.DeviceID) > 128 {
			e.failHello(s, "unpaired")
			return
		}
		ephP, err := canon.DecodeB64URL(h.EphX25519)
		if err != nil || len(ephP) != 32 {
			e.failHello(s, "unpaired")
			return
		}
		nonce, err := canon.DecodeB64URL(h.Nonce)
		if err != nil || len(nonce) != 16 {
			e.failHello(s, "unpaired")
			return
		}
		now := time.Now()
		e.mu.Lock()
		if s.state != "resumehello" || e.sessions[s.routeID] != s {
			e.mu.Unlock()
			return
		}
		dev := e.Devices[h.DeviceID]
		if dev == nil {
			e.mu.Unlock()
			e.failHello(s, "unpaired")
			return
		}
		s.deviceID = h.DeviceID
		if dev.RevokedAt != nil {
			e.mu.Unlock()
			e.failHello(s, "revoked")
			return
		}
		if !e.allowHelloLocked(h.DeviceID, now) {
			e.mu.Unlock()
			e.failHello(s, "rate_limited")
			return
		}
		if !e.rememberNonceLocked(h.DeviceID, nonce) {
			e.mu.Unlock()
			e.failHello(s, "replay")
			return
		}
		var ephSk, ephPk [32]byte
		if _, err := rand.Read(ephSk[:]); err != nil {
			e.mu.Unlock()
			e.failHello(s, "unpaired")
			return
		}
		curve25519.ScalarBaseMult(&ephPk, &ephSk)
		copy(s.peerPk[:], ephP)
		s.ephSk, s.ephPk = ephSk, ephPk
		s.nonce = append([]byte(nil), nonce...)
		s.hello1 = h
		s.ts = now.Unix()
		s.state = "hello2"
		td := sessionkeys.TranscriptD(e.DaemonID, h.DeviceID, ephP, ephPk[:], nonce, s.ts, s.routeID)
		proof := sessionkeys.Proof(dev.PSK, td)
		sig := sessionkeys.Sign(e.SK, td)
		ts := s.ts
		e.mu.Unlock()
		payload, _ := json.Marshal(sessionkeys.Hello2{
			V: 1, Op: "DeviceHello2", OK: true, EphX25519: canon.B64URL(ephPk[:]), TS: ts,
			ProofD: canon.B64URL(proof), SigD: canon.B64URL(sig),
		})
		_ = e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload})
	case "DeviceHello3":
		var h sessionkeys.Hello3
		if json.Unmarshal(f.Payload, &h) != nil || h.Op != "DeviceHello3" {
			e.failHello(s, "unpaired")
			return
		}
		proof, err := canon.DecodeB64URL(h.ProofP)
		if err != nil || len(proof) != 32 || !e.FinishHello3(s, proof, e.LastTS(s)) {
			e.failHello(s, "unpaired")
		}
	default:
		e.failHello(s, "unpaired")
	}
}

// FinishHello3 verifies the phone proof, rotates session keys, kicks any old
// route for the device, then sends SESSION_ESTABLISHED for the new route.
func (e *Engine) FinishHello3(s *sess, proofP []byte, ts int64) bool {
	if s == nil || len(proofP) != 32 || ts <= 0 {
		return false
	}
	e.mu.Lock()
	dev := e.Devices[s.deviceID]
	if dev == nil || dev.RevokedAt != nil || s.state != "hello2" || e.sessions[s.routeID] != s || len(s.nonce) != 16 {
		e.mu.Unlock()
		return false
	}
	td := sessionkeys.TranscriptD(e.DaemonID, s.deviceID, s.peerPk[:], s.ephPk[:], s.nonce, ts, s.routeID)
	want := sessionkeys.Proof(dev.PSK, sessionkeys.TranscriptP(td))
	if !sessionkeys.HMACEqual(want, proofP) {
		e.mu.Unlock()
		return false
	}
	dh, err := curve25519.X25519(s.ephSk[:], s.peerPk[:])
	if err != nil || len(dh) != 32 {
		e.mu.Unlock()
		return false
	}
	c2s, s2c := sessionkeys.SessionKeys(dh, dev.PSK)
	if s.upgradeFrom != ([16]byte{}) {
		parent := e.sessions[s.upgradeFrom]
		if parent == nil || parent.state != "established" || parent.transport != "relay" || parent.deviceID != s.deviceID {
			e.mu.Unlock()
			e.closeSession(s.routeID, "conflict", true)
			return false
		}
		s.c2s = &aead.Direction{Key: c2s, Dir: aead.DirClient}
		s.s2c = &aead.Direction{Key: s2c, Dir: aead.DirServer}
		s.state = "upgrade_ready"
		e.mu.Unlock()
		if err := e.sendSessionFrame(s, envelope.JSON(envelope.TypSESSION_ESTABLISHED, s.routeID, map[string]any{
			"v": e.muxVersion(), "route_id": hex.EncodeToString(s.routeID[:]),
		})); err != nil {
			e.closeSession(s.routeID, "daemon_offline", false)
			return false
		}
		e.audit("p2p_ready", map[string]any{"device_id": s.deviceID})
		return true
	}
	old, hasOld := e.byDevice[s.deviceID]
	nEst := 0
	for _, other := range e.sessions {
		if other.state == "established" && other.deviceID != s.deviceID {
			nEst++
		}
	}
	if !hasOld && nEst >= 10 {
		e.mu.Unlock()
		e.closeSession(s.routeID, "too_many_devices", true)
		return false
	}
	s.c2s = &aead.Direction{Key: c2s, Dir: aead.DirClient}
	s.s2c = &aead.Direction{Key: s2c, Dir: aead.DirServer}
	s.state = "established"
	e.byDevice[s.deviceID] = s.routeID
	previousLastSeen := dev.LastSeen
	dev.LastSeen = time.Now().Unix()
	if err := e.saveDevicesLocked(); err != nil {
		dev.LastSeen = previousLastSeen
		delete(e.byDevice, s.deviceID)
		s.state = "hello2"
		s.c2s, s.s2c = nil, nil
		e.mu.Unlock()
		e.closeSession(s.routeID, "daemon_offline", true)
		e.audit("session_persist_failed", map[string]any{"device_id": s.deviceID, "error": err.Error()})
		return false
	}
	e.mu.Unlock()

	// Ordering is protocol-significant: old route ERROR must precede the new
	// route's SESSION_ESTABLISHED signal.
	if hasOld && old != s.routeID {
		e.closeSession(old, "kicked", true)
	}
	if err := e.sendSessionFrame(s, envelope.JSON(envelope.TypSESSION_ESTABLISHED, s.routeID, map[string]any{
		"v": e.muxVersion(), "route_id": hex.EncodeToString(s.routeID[:]),
	})); err != nil {
		e.closeSession(s.routeID, "daemon_offline", false)
		return false
	}
	e.audit("session_established", map[string]any{"device_id": s.deviceID, "route_id": hex.EncodeToString(s.routeID[:])})
	return true
}

func (e *Engine) wipeSession(s *sess) {
	if s == nil {
		return
	}
	if s.c2s != nil {
		for i := range s.c2s.Key {
			s.c2s.Key[i] = 0
		}
	}
	if s.s2c != nil {
		for i := range s.s2c.Key {
			s.s2c.Key[i] = 0
		}
	}
	for i := range s.ephSk {
		s.ephSk[i] = 0
	}
	s.c2s, s.s2c = nil, nil
	s.nonce = nil
}

func (e *Engine) closeSession(rid [16]byte, code string, notify bool) {
	e.mu.Lock()
	s := e.sessions[rid]
	if s == nil {
		e.mu.Unlock()
		return
	}
	deviceID := s.deviceID
	s.state = "closed"
	if active, ok := e.byDevice[deviceID]; ok && active == rid {
		delete(e.byDevice, deviceID)
	}
	delete(e.sessions, rid)
	e.mu.Unlock()
	stopSessionRPC(s)
	closeSessionTerminal(s)
	if notify && code != "" {
		_ = e.sendSessionFrame(s, envelope.JSON(envelope.TypERROR, rid, envelope.ErrorBody{
			Code: code, RouteID: hex.EncodeToString(rid[:]), Message: code,
		}))
	}
	s.sendMu.Lock()
	e.wipeSession(s)
	s.sendMu.Unlock()
	if s.transport == "p2p" && s.link != nil {
		s.link.Close()
	}
}

func (e *Engine) closeDeviceSessions(deviceID, code string) {
	e.mu.Lock()
	var routes [][16]byte
	for rid, s := range e.sessions {
		if s.deviceID == deviceID {
			routes = append(routes, rid)
		}
	}
	e.mu.Unlock()
	for _, rid := range routes {
		e.closeSession(rid, code, true)
	}
}

func (e *Engine) deviceConnectedLocked(deviceID string) bool {
	for _, s := range e.sessions {
		if s.deviceID == deviceID && (s.state == "established" || s.state == "upgrade_ready") {
			return true
		}
	}
	return false
}

// ResetTransport drops relay sessions and uncommitted direct candidates after
// the daemon relay WebSocket dies. Established P2P sessions are independent of
// that socket and remain live. Persistent credentials and daemon keys remain.
// It returns true when an in-flight AEAD pairing had to be burned and a new slot should
// be opened after reconnect.
func (e *Engine) ResetTransport() bool {
	e.mu.Lock()
	sessions := make([]*sess, 0, len(e.sessions))
	for rid, s := range e.sessions {
		if s.transport == "p2p" && s.state == "established" {
			continue
		}
		s.state = "closed"
		sessions = append(sessions, s)
		delete(e.sessions, rid)
		if active, ok := e.byDevice[s.deviceID]; ok && active == rid {
			delete(e.byDevice, s.deviceID)
		}
	}
	needNewPair := false
	if pair := e.pair; pair != nil && !pair.closed {
		if pair.confirmVerified || pair.pairedAEAD || pair.admitted {
			e.burnPairLocked(pair)
			needNewPair = true
		} else {
			pair.routeID = [16]byte{}
			pair.attempt = ""
			e.resetPairAttemptLocked(pair)
		}
	}
	e.mu.Unlock()
	for _, s := range sessions {
		stopSessionRPC(s)
		closeSessionTerminal(s)
		s.sendMu.Lock()
		e.wipeSession(s)
		s.sendMu.Unlock()
		if s.transport == "p2p" && s.link != nil {
			s.link.Close()
		}
	}
	e.audit("relay_transport_reset", map[string]any{"sessions": len(sessions), "new_pair_required": needNewPair})
	return needNewPair
}

func (e *Engine) Session(rid [16]byte) *sess {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.sessions[rid]
}

func (e *Engine) LastTS(s *sess) int64 {
	if s == nil {
		return 0
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return s.ts
}

var errRevoked = errors.New("device not found or already revoked")

// RevokeDevice persists revocation, clears push subscriptions, and immediately
// terminates every active route authenticated as that device.
func (e *Engine) markDeviceRevoked(deviceID string) error {
	e.mu.Lock()
	dev := e.Devices[deviceID]
	if dev == nil || dev.RevokedAt != nil {
		e.mu.Unlock()
		return errRevoked
	}
	now := time.Now().Unix()
	previousSubscriptions := dev.PushSubscriptions
	dev.RevokedAt = &now
	dev.PushSubscriptions = nil
	if err := e.saveDevicesLocked(); err != nil {
		dev.RevokedAt = nil
		dev.PushSubscriptions = previousSubscriptions
		e.mu.Unlock()
		return err
	}
	e.mu.Unlock()
	e.audit("device_revoked", map[string]any{"device_id": deviceID})
	return nil
}

func (e *Engine) RevokeDevice(deviceID string) error {
	if err := e.markDeviceRevoked(deviceID); err != nil {
		return err
	}
	e.closeDeviceSessions(deviceID, "revoked")
	return nil
}
