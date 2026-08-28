package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/crypto/spake2plus"
	"pairfob/internal/envelope"
	"pairfob/internal/pairingqr"
)

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const maxDeviceLabelBytes = 120

func validDeviceLabel(label string) bool {
	if len([]byte(label)) > maxDeviceLabelBytes || !utf8.ValidString(label) {
		return false
	}
	return strings.IndexFunc(label, unicode.IsControl) == -1
}

func GeneratePairCode() (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	out := make([]byte, len(raw))
	for i, b := range raw {
		out[i] = crockfordAlphabet[int(b)&31]
	}
	return string(out), nil
}

func normalizePairCode(code string) (string, error) {
	norm := canon.NormalizeCrockford(code)
	if len(norm) != 8 {
		return "", errors.New("pairing code must be exactly 8 Crockford characters")
	}
	for _, c := range norm {
		if !strings.ContainsRune(crockfordAlphabet, c) {
			return "", errors.New("pairing code contains an invalid Crockford character")
		}
	}
	return norm, nil
}

func (e *Engine) OpenPairing(code string) (PairingStatus, error) {
	e.pairOpenMu.Lock()
	defer e.pairOpenMu.Unlock()
	if e.DaemonID == "" {
		return PairingStatus{}, errors.New("daemon must register before pairing")
	}
	var err error
	if code == "" {
		code, err = GeneratePairCode()
		if err != nil {
			return PairingStatus{}, err
		}
	}
	norm, err := normalizePairCode(code)
	if err != nil {
		return PairingStatus{}, err
	}
	pairRef := make([]byte, 16)
	if _, err := rand.Read(pairRef); err != nil {
		return PairingStatus{}, err
	}
	ref := canon.PairRefHex(pairRef)
	if _, err := e.pairingOffer(ref, norm, ""); err != nil {
		return PairingStatus{}, err
	}
	record := spake2plus.DeriveRecord(norm, e.DaemonID, ref)
	ttl := e.pairingTTL()
	pair := &pairingSlot{
		ref: ref, code: norm, record: record,
		admitCh: make(chan struct{}), readyCh: make(chan struct{}),
		expiresAt: time.Now().Add(ttl),
	}
	if e.muxVersion() == 2 {
		pair.openWait = make(chan error, 1)
	}

	e.mu.Lock()
	oldRef := e.burnPairLocked(e.pair)
	e.pair = pair
	e.mu.Unlock()
	if oldRef != "" {
		e.sendPairClose(oldRef)
	}
	if err := e.Conn.Send(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, e.pairOpenPayload(ref))); err != nil {
		e.mu.Lock()
		if e.pair != nil && e.pair.ref == ref {
			e.burnPairLocked(e.pair)
		}
		e.mu.Unlock()
		return PairingStatus{}, err
	}
	if e.muxVersion() == 2 {
		if err := e.waitPairOpenAck(pair); err != nil {
			return PairingStatus{}, err
		}
	}
	expiry := time.AfterFunc(ttl, func() { e.expirePairing(pair) })
	e.mu.Lock()
	if e.pair == pair && !pair.closed {
		pair.expiry = expiry
	} else {
		expiry.Stop()
	}
	loc := ""
	if pair.locReady {
		loc = pair.loc
	}
	expires := pair.expiresAt
	devices := e.pairedCountLocked()
	e.mu.Unlock()
	offer, err := e.pairingOffer(ref, norm, loc)
	if err != nil {
		return PairingStatus{}, err
	}
	e.audit("pair_open", map[string]any{"pair_ref": ref})
	return PairingStatus{Ref: ref, Code: norm, URL: offer.URL, Loc: loc, Devices: devices, ExpiresAt: expires}, nil
}

func (e *Engine) pairingTTL() time.Duration {
	ttl := e.PairingTTL
	if ttl < 60*time.Second || ttl > 300*time.Second {
		return PairingTTLDefault
	}
	return ttl
}

func (e *Engine) pairOpenPayload(ref string) map[string]any {
	ttl := int(e.pairingTTL().Seconds())
	return map[string]any{
		"v": e.muxVersion(), "op": "CreatePairing", "daemon_id": e.DaemonID,
		"pair_ref": ref, "ttl_s": ttl,
	}
}

func (e *Engine) pairingOffer(ref, code, loc string) (pairingqr.Offer, error) {
	return pairingqr.NewOffer(e.Origin, e.DaemonID, ref, code, canon.Fingerprint16(e.PK), e.muxVersion(), loc)
}

func (e *Engine) pairOpenAckWait() time.Duration {
	if e.PairOpenAckWait > 0 {
		return e.PairOpenAckWait
	}
	return 15 * time.Second
}

func (e *Engine) waitPairOpenAck(pair *pairingSlot) error {
	timer := time.NewTimer(e.pairOpenAckWait())
	defer timer.Stop()
	select {
	case err := <-pair.openWait:
		return err
	case <-timer.C:
	}
	e.mu.Lock()
	ready := pair.locReady && !pair.closed
	e.mu.Unlock()
	if ready {
		return nil
	}
	select {
	case err := <-pair.openWait:
		return err
	default:
	}
	e.failPairOpen(pair.ref, errors.New("pair_open_timeout"))
	return errors.New("pair_open_timeout")
}

func (e *Engine) signalPairOpenLocked(pair *pairingSlot, err error) {
	if pair == nil || pair.openWait == nil {
		return
	}
	pair.openOnce.Do(func() { pair.openWait <- err })
}

func (e *Engine) failPairOpen(expectedRef string, err error) {
	e.mu.Lock()
	pair := e.pair
	if pair == nil || pair.closed || pair.locReady || expectedRef == "" || pair.ref != expectedRef {
		e.mu.Unlock()
		return
	}
	e.signalPairOpenLocked(pair, err)
	ref := e.burnPairLocked(pair)
	e.mu.Unlock()
	if ref != "" {
		e.sendPairClose(ref)
	}
}

func normalizePairLoc(loc string) (string, error) {
	norm := canon.NormalizeCrockford(loc)
	if len(norm) != 6 {
		return "", errors.New("pair_loc must be exactly 6 Crockford characters")
	}
	for _, c := range norm {
		if !strings.ContainsRune(crockfordAlphabet, c) {
			return "", errors.New("pair_loc contains an invalid Crockford character")
		}
	}
	return norm, nil
}

func (e *Engine) handlePairOpenAck(f envelope.Frame) {
	if e.muxVersion() != 2 {
		return
	}
	var body struct {
		V       int    `json:"v"`
		Op      string `json:"op"`
		OK      bool   `json:"ok"`
		PairRef string `json:"pair_ref"`
		PairLoc string `json:"pair_loc"`
		TTLS    int    `json:"ttl_s"`
		Error   *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(f.Payload, &body) != nil || body.V != 2 || (body.Op != "" && body.Op != "CreatePairing") {
		return
	}
	if !body.OK {
		code := "index_unavailable"
		if body.Error != nil && body.Error.Code != "" {
			code = body.Error.Code
		}
		e.failPairOpen(body.PairRef, errors.New(code))
		return
	}
	loc, err := normalizePairLoc(body.PairLoc)
	if err != nil {
		e.failPairOpen(body.PairRef, err)
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	pair := e.pair
	if pair == nil || pair.closed || pair.ref != body.PairRef {
		return
	}
	pair.loc = loc
	pair.locReady = true
	if body.TTLS >= 60 && body.TTLS <= 300 {
		pair.expiresAt = time.Now().Add(time.Duration(body.TTLS) * time.Second)
	}
	e.signalPairOpenLocked(pair, nil)
}

func (e *Engine) RefreshPairing() {
	e.mu.Lock()
	pair := e.pair
	if pair == nil || pair.closed || pair.acked {
		e.mu.Unlock()
		return
	}
	if e.muxVersion() == 2 && !pair.locReady {
		e.mu.Unlock()
		return
	}
	ref := pair.ref
	e.mu.Unlock()
	_ = e.Conn.Send(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, e.pairOpenPayload(ref)))
}

func (e *Engine) expirePairing(pair *pairingSlot) {
	e.mu.Lock()
	if e.pair != pair || pair.closed {
		e.mu.Unlock()
		return
	}
	ref := e.burnPairLocked(pair)
	e.mu.Unlock()
	e.sendPairClose(ref)
	e.audit("pair_expired", map[string]any{"pair_ref": ref})
}

// Admit authorizes the active one-use pairing slot. It may run before or after
// the phone completes PAKE so the operator never has to race the handshake.
func (e *Engine) Admit(ref string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	pair := e.pair
	if pair == nil || pair.closed || ref == "" || ref != pair.ref {
		return errors.New("pair_ref does not match the active pairing")
	}
	if pair.admitted {
		return nil
	}
	pair.admitted = true
	pair.admitOnce.Do(func() { close(pair.admitCh) })
	e.audit("pair_admit", map[string]any{"pair_ref": pair.ref})
	return nil
}

// Deny burns the active slot. A denied code and pair_ref can never be reused.
func (e *Engine) Deny(ref string) error {
	e.mu.Lock()
	pair := e.pair
	if pair == nil || pair.closed || ref == "" || ref != pair.ref {
		e.mu.Unlock()
		return errors.New("pair_ref does not match the active pairing")
	}
	closedRef := e.burnPairLocked(pair)
	e.mu.Unlock()
	e.sendPairClose(closedRef)
	e.audit("pair_deny", map[string]any{"pair_ref": ref})
	return nil
}

// WaitPairingReady blocks until the phone proves possession of the pairing
// code for this exact slot. It does not authorize the pairing.
func (e *Engine) WaitPairingReady(ref string) (PairingStatus, error) {
	e.mu.Lock()
	pair := e.pair
	if pair == nil || pair.closed || ref == "" || ref != pair.ref {
		e.mu.Unlock()
		return PairingStatus{}, errors.New("pair_ref does not match the active pairing")
	}
	if pair.confirmVerified {
		status := e.pairingStatusLocked(pair)
		e.mu.Unlock()
		return status, nil
	}
	ready := pair.readyCh
	e.mu.Unlock()

	<-ready
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.pair != pair || pair.closed || !pair.confirmVerified {
		return PairingStatus{}, errors.New("pairing closed before phone proof")
	}
	return e.pairingStatusLocked(pair), nil
}

func (e *Engine) pairingStatusLocked(pair *pairingSlot) PairingStatus {
	if pair == nil || pair.closed {
		return PairingStatus{Devices: e.pairedCountLocked()}
	}
	loc := ""
	if pair.locReady {
		loc = pair.loc
	}
	offer, _ := e.pairingOffer(pair.ref, pair.code, loc)
	return PairingStatus{
		Ref: pair.ref, Code: pair.code, URL: offer.URL, Loc: loc,
		Admitted: pair.admitted, Ready: pair.confirmVerified,
		Devices: e.pairedCountLocked(), ExpiresAt: pair.expiresAt,
	}
}

func (e *Engine) PairingStatus() PairingStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pairingStatusLocked(e.pair)
}

func (e *Engine) pairedCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pairedCountLocked()
}

func (e *Engine) waitAdmit(pair *pairingSlot) bool {
	if pair == nil {
		return false
	}
	ttl := e.pairingTTL()
	t := time.NewTimer(ttl)
	defer t.Stop()
	select {
	case <-pair.admitCh:
		e.mu.Lock()
		ok := pair.admitted && !pair.closed && e.pair == pair
		e.mu.Unlock()
		return ok
	case <-t.C:
		return false
	}
}

func (e *Engine) handlePairAttached(f envelope.Frame) {
	var body struct {
		V         int    `json:"v"`
		AttemptID string `json:"attempt_id"`
		RouteID   string `json:"route_id"`
	}
	if err := json.Unmarshal(f.Payload, &body); err != nil || body.V != e.muxVersion() || body.AttemptID == "" || len(body.AttemptID) > 128 {
		return
	}
	raw, err := hex.DecodeString(body.RouteID)
	if err != nil || len(raw) != 16 {
		return
	}
	var rid [16]byte
	copy(rid[:], raw)
	if f.RouteID != rid {
		return
	}
	e.mu.Lock()
	pair := e.pair
	if pair == nil || pair.closed || pair.confirmVerified || pair.pairedAEAD {
		e.mu.Unlock()
		return
	}
	pair.routeID, pair.attempt = rid, body.AttemptID
	e.resetPairAttemptLocked(pair)
	e.mu.Unlock()
	e.audit("pair_attached", map[string]any{"pair_ref": pair.ref, "attempt_id": body.AttemptID})
}

func (e *Engine) resetPairAttemptLocked(pair *pairingSlot) {
	pair.verifier = spake2plus.NewVerifier(pair.record, spake2plus.IdProver(pair.ref), e.DaemonID, "")
	pair.keys = spake2plus.Keys{}
	pair.sas = ""
	pair.confirmVerified = false
	pair.confirmStarted = false
	pair.pairedAEAD = false
	pair.c2s, pair.s2c = nil, nil
}

func (e *Engine) pairFailureLocked(pair *pairingSlot, reason string) (burnedRef string) {
	if pair == nil || pair.closed || e.pair != pair {
		return ""
	}
	pair.failures++
	e.audit("pair_failure", map[string]any{"pair_ref": pair.ref, "attempt_id": pair.attempt, "reason": reason, "failures": pair.failures})
	if pair.failures >= 3 {
		return e.burnPairLocked(pair)
	}
	e.resetPairAttemptLocked(pair)
	return ""
}

func (e *Engine) rejectPairAttemptLocked(pair *pairingSlot, reason string) (burnedRef string, routeID [16]byte) {
	if pair != nil {
		routeID = pair.routeID
	}
	return e.pairFailureLocked(pair, reason), routeID
}

func (e *Engine) sendPairAttemptFailure(ref string, routeID [16]byte) {
	if routeID != ([16]byte{}) {
		_ = e.Conn.Send(envelope.JSON(envelope.TypERROR, routeID, envelope.ErrorBody{
			Code: "bad_pair_code", RouteID: hex.EncodeToString(routeID[:]), Message: "pairing proof rejected",
		}))
	}
	e.sendPairClose(ref)
}

func (e *Engine) burnPairLocked(pair *pairingSlot) string {
	if pair == nil || pair.closed {
		return ""
	}
	pair.closed = true
	if pair.expiry != nil {
		pair.expiry.Stop()
		pair.expiry = nil
	}
	pair.admitted = false
	e.signalPairOpenLocked(pair, errors.New("pairing closed"))
	pair.admitOnce.Do(func() { close(pair.admitCh) })
	if pair.readyCh != nil {
		pair.readyOnce.Do(func() { close(pair.readyCh) })
	}
	for i := range pair.psk {
		pair.psk[i] = 0
	}
	pair.keys = spake2plus.Keys{}
	pair.c2s, pair.s2c, pair.verifier = nil, nil, nil
	if e.pair == pair {
		e.pair = nil
	}
	return pair.ref
}

func (e *Engine) sendPairClose(ref string) {
	if ref == "" {
		return
	}
	_ = e.Conn.Send(envelope.JSON(envelope.TypPAIR_CLOSE, [16]byte{}, map[string]any{"v": e.muxVersion(), "pair_ref": ref}))
}

func (e *Engine) handlePairFWD(f envelope.Frame, pair *pairingSlot) {
	e.mu.Lock()
	if pair.closed || e.pair != pair || f.RouteID != pair.routeID {
		e.mu.Unlock()
		return
	}
	if pair.pairedAEAD {
		pt, err := aead.Open(pair.c2s, pair.routeID, f.Payload)
		if err != nil {
			ref := e.burnPairLocked(pair)
			e.mu.Unlock()
			e.sendPairClose(ref)
			return
		}
		var ack struct {
			V      int    `json:"v"`
			ID     string `json:"id"`
			OK     bool   `json:"ok"`
			Result struct {
				Label string `json:"label"`
			} `json:"result"`
		}
		if json.Unmarshal(pt, &ack) != nil || ack.V != 1 || !ack.OK || ack.ID != pair.confirmID || !validDeviceLabel(ack.Result.Label) {
			ref := e.burnPairLocked(pair)
			e.mu.Unlock()
			e.sendPairClose(ref)
			return
		}
		device := &Device{ID: pair.deviceID, PSK: append([]byte(nil), pair.psk...), Label: strings.TrimSpace(ack.Result.Label), Created: time.Now().Unix()}
		e.Devices[device.ID] = device
		persistErr := e.saveDevicesLocked()
		pair.acked = persistErr == nil
		if persistErr != nil {
			delete(e.Devices, device.ID)
		}
		ref := e.burnPairLocked(pair)
		e.mu.Unlock()
		e.sendPairClose(ref)
		if persistErr != nil {
			e.audit("pair_persist_failed", map[string]any{"pair_ref": ref, "error": persistErr.Error()})
			return
		}
		e.audit("pair_complete", map[string]any{"pair_ref": ref, "device_id": device.ID})
		return
	}

	var msg struct {
		V       int    `json:"v"`
		Op      string `json:"op"`
		Share   string `json:"share"`
		Confirm string `json:"confirm_p"`
	}
	if json.Unmarshal(f.Payload, &msg) != nil || msg.V != 1 {
		ref, rid := e.rejectPairAttemptLocked(pair, "bad_json")
		e.mu.Unlock()
		e.sendPairAttemptFailure(ref, rid)
		return
	}
	switch msg.Op {
	case "SpakeShareP":
		if pair.verifier == nil || pair.confirmVerified || msg.Confirm != "" {
			ref, rid := e.rejectPairAttemptLocked(pair, "bad_state")
			e.mu.Unlock()
			e.sendPairAttemptFailure(ref, rid)
			return
		}
		shareP, err := canon.DecodeB64URL(msg.Share)
		if err != nil || len(shareP) != 65 {
			ref, rid := e.rejectPairAttemptLocked(pair, "bad_share")
			e.mu.Unlock()
			e.sendPairAttemptFailure(ref, rid)
			return
		}
		shareV, keys, err := pair.verifier.Finish(shareP)
		if err != nil {
			ref, rid := e.rejectPairAttemptLocked(pair, "invalid_point")
			e.mu.Unlock()
			e.sendPairAttemptFailure(ref, rid)
			return
		}
		pair.keys = keys
		payload, err := json.Marshal(map[string]any{
			"v": 1, "op": "SpakeShareV", "attempt_id": pair.attempt,
			"share": canon.B64URL(shareV), "confirm_v": canon.B64URL(keys.ConfirmV),
		})
		e.mu.Unlock()
		if err == nil {
			_ = e.Conn.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: pair.routeID, Payload: payload})
		}
	case "SpakeConfirmP":
		if len(pair.keys.ConfirmP) != 32 || pair.confirmVerified || msg.Share != "" {
			ref, rid := e.rejectPairAttemptLocked(pair, "bad_state")
			e.mu.Unlock()
			e.sendPairAttemptFailure(ref, rid)
			return
		}
		got, err := canon.DecodeB64URL(msg.Confirm)
		if err != nil || len(got) != 32 || !spake2plus.ConfirmEqual(got, pair.keys.ConfirmP) {
			ref, rid := e.rejectPairAttemptLocked(pair, "bad_confirm")
			e.mu.Unlock()
			e.sendPairAttemptFailure(ref, rid)
			return
		}
		pair.confirmVerified = true
		if pair.readyCh != nil {
			pair.readyOnce.Do(func() { close(pair.readyCh) })
		}
		pair.sas = sessionkeys.SAS(pair.keys.KShared)
		c2s, s2c := sessionkeys.PairingKeys(pair.keys.KShared)
		pair.c2s = &aead.Direction{Key: c2s, Dir: aead.DirClient}
		pair.s2c = &aead.Direction{Key: s2c, Dir: aead.DirServer}
		if pair.confirmStarted {
			e.mu.Unlock()
			return
		}
		pair.confirmStarted = true
		e.mu.Unlock()
		go e.issueConfirmPairing(pair)
	default:
		ref, rid := e.rejectPairAttemptLocked(pair, "unknown_op")
		e.mu.Unlock()
		e.sendPairAttemptFailure(ref, rid)
	}
}

func (e *Engine) issueConfirmPairing(pair *pairingSlot) {
	accepted := e.AutoAdmit || e.waitAdmit(pair)
	if !accepted {
		e.mu.Lock()
		ref := e.burnPairLocked(pair)
		e.mu.Unlock()
		e.sendPairClose(ref)
		e.audit("pair_timeout_or_reject", map[string]any{"pair_ref": pair.ref})
		return
	}
	credential := make([]byte, 48)
	if _, err := rand.Read(credential); err != nil {
		e.mu.Lock()
		ref := e.burnPairLocked(pair)
		e.mu.Unlock()
		e.sendPairClose(ref)
		return
	}
	dev := "dev_" + hex.EncodeToString(credential[:8])
	psk := append([]byte(nil), credential[8:40]...)
	e.mu.Lock()
	if e.pair != pair || pair.closed || !pair.confirmVerified {
		e.mu.Unlock()
		return
	}
	pair.deviceID, pair.psk = dev, psk
	pair.confirmID = "req_" + hex.EncodeToString(credential[40:])
	pair.pairedAEAD = true
	body, err := json.Marshal(map[string]any{
		"v": 1, "id": pair.confirmID, "op": "ConfirmPairing",
		"params": map[string]any{
			"device_id": dev, "device_psk": canon.B64URL(psk), "daemon_id": e.DaemonID,
			"daemon_pk": canon.B64URL(e.PK), "sas": pair.sas, "relay_origin": e.Origin,
			"fp": canon.Fingerprint16(e.PK),
		},
	})
	if err != nil {
		ref := e.burnPairLocked(pair)
		e.mu.Unlock()
		e.sendPairClose(ref)
		return
	}
	payload, err := aead.Seal(pair.s2c, pair.routeID, body)
	if err != nil {
		ref := e.burnPairLocked(pair)
		e.mu.Unlock()
		e.sendPairClose(ref)
		return
	}
	rid := pair.routeID
	e.mu.Unlock()
	if err := e.Conn.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: rid, Payload: payload}); err != nil {
		e.mu.Lock()
		ref := e.burnPairLocked(pair)
		e.mu.Unlock()
		e.sendPairClose(ref)
	}
}
