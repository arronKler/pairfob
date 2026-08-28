package mux

import (
	"encoding/hex"
	"time"

	"pairfob/internal/envelope"
)

func (h *Hub) pairOpen(c Conn, f envelope.Frame) {
	var req struct {
		V        int    `json:"v"`
		Op       string `json:"op"`
		DaemonID string `json:"daemon_id"`
		PairRef  string `json:"pair_ref"`
		TTLS     int    `json:"ttl_s"`
	}
	if !isZeroRID(f.RouteID) {
		h.reject(c, "bad_token", "PAIR_OPEN route_id must be zero")
		return
	}
	if err := decodeJSON(f.Payload, &req); err != nil || req.V != 1 || (req.Op != "" && req.Op != "CreatePairing") {
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "invalid pairing slot"})
		return
	}
	ref, err := hex.DecodeString(req.PairRef)
	if err != nil || len(ref) != 16 || hex.EncodeToString(ref) != req.PairRef {
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "invalid pair_ref"})
		return
	}
	h.mu.Lock()
	d := h.daemonByConn(c)
	if d == nil {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "unbound", Message: "no daemon"})
		return
	}
	if d.id != req.DaemonID || d.conn == nil {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "unbound", Message: "daemon_id does not match websocket"})
		return
	}
	ttl := h.ttlPair
	if req.TTLS >= 60 && req.TTLS <= 300 {
		ttl = time.Duration(req.TTLS) * time.Second
	}
	deadline := h.now().Add(ttl)
	if sl := d.pairSlots[req.PairRef]; sl != nil {
		sl.deadline = deadline
		h.armPairExpiryLocked(d, sl, ttl)
		h.mu.Unlock()
		return
	}
	// One live slot; replacing it notifies the previous daemon and phone.
	var pending []pendingSend
	for _, other := range h.daemons {
		for otherRef, existing := range other.pairSlots {
			if existing.bind != nil {
				pending = append(pending, h.queueCloseBindLocked(existing.bind, envelope.JSON(envelope.TypERROR, existing.bind.id, envelope.ErrorBody{
					Code: "pairing_replaced", RouteID: hex.EncodeToString(existing.bind.id[:]), PairRef: existing.ref, Message: "another computer opened pairing",
				}), true)...)
			}
			if existing.timer != nil {
				existing.timer.Stop()
			}
			delete(other.pairSlots, otherRef)
			if other != d && other.conn != nil {
				pending = append(pending, pendingSend{c: other.conn, f: envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{
					Code: "pairing_replaced", PairRef: existing.ref, Message: "another computer opened pairing",
				})})
			}
		}
	}
	sl := &pairSlot{ref: req.PairRef, deadline: deadline}
	d.pairSlots[req.PairRef] = sl
	h.armPairExpiryLocked(d, sl, ttl)
	h.mu.Unlock()
	flushPending(pending)
}

func (h *Hub) pairClose(c Conn, f envelope.Frame) {
	var req struct {
		V       int    `json:"v"`
		PairRef string `json:"pair_ref"`
	}
	if !isZeroRID(f.RouteID) || decodeJSON(f.Payload, &req) != nil || req.V != 1 || !isLowerHex(req.PairRef, 16) {
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "invalid pair_ref"})
		return
	}
	h.mu.Lock()
	d := h.daemonByConn(c)
	if d == nil {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "unbound", Message: "no daemon"})
		return
	}
	var pending []pendingSend
	if sl, ok := d.pairSlots[req.PairRef]; ok && sl.bind != nil {
		pending = h.queueCloseBindLocked(sl.bind, routeErrFrame(sl.bind, "unpaired", "pairing closed"), false)
	}
	if sl := d.pairSlots[req.PairRef]; sl != nil && sl.timer != nil {
		sl.timer.Stop()
	}
	delete(d.pairSlots, req.PairRef)
	h.mu.Unlock()
	flushPending(pending)
}

// armPairExpiryLocked requires h.mu held.
func (h *Hub) armPairExpiryLocked(d *daemonSlot, sl *pairSlot, ttl time.Duration) {
	if sl.timer != nil {
		sl.timer.Stop()
	}
	sl.timer = time.AfterFunc(ttl, func() {
		h.mu.Lock()
		if current := d.pairSlots[sl.ref]; current != sl {
			h.mu.Unlock()
			return
		}
		var pending []pendingSend
		if sl.bind != nil {
			pending = append(pending, h.queueCloseBindLocked(sl.bind, envelope.JSON(envelope.TypERROR, sl.bind.id, envelope.ErrorBody{
				Code: "unpaired", RouteID: hex.EncodeToString(sl.bind.id[:]), Message: "pairing slot expired",
			}), true)...)
		}
		delete(d.pairSlots, sl.ref)
		if d.conn != nil {
			pending = append(pending, pendingSend{c: d.conn, f: envelope.JSON(envelope.TypERROR, [16]byte{}, envelope.ErrorBody{
				Code: "pairing_expired", PairRef: sl.ref, Message: "pairing slot expired",
			})})
		}
		h.mu.Unlock()
		flushPending(pending)
	})
}

func (h *Hub) pairAttach(st *clientState, f envelope.Frame) {
	var req struct {
		V       int    `json:"v"`
		PairRef string `json:"pair_ref"`
	}
	if !isZeroRID(f.RouteID) || decodeJSON(f.Payload, &req) != nil || req.V != 1 {
		h.reject(st.conn, "bad_token", "invalid PAIR_ATTACH payload")
		return
	}
	if req.PairRef != "" && !isLowerHex(req.PairRef, 16) {
		h.sendErr(st.conn, envelope.ErrorBody{Code: "bad_token", Message: "invalid pair_ref"})
		return
	}
	h.mu.Lock()
	if !st.hello || h.now().Sub(st.helloAt) > h.helloGrace {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "unbound", Message: "PAIR_ATTACH after HELLO timeout"})
		st.conn.Close()
		return
	}
	if st.mode == "session" {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "wrong_ws", Message: "PAIR_ATTACH on SessionWS"})
		return
	}
	if st.bind != nil || st.mode == "pairing" {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "wrong_ws", Message: "PairingWS already attached"})
		return
	}
	var found *pairSlot
	var d *daemonSlot
	for _, ds := range h.daemons {
		if ds.conn == nil {
			continue
		}
		if req.PairRef != "" {
			if sl := ds.pairSlots[req.PairRef]; sl != nil {
				if h.now().After(sl.deadline) {
					if sl.timer != nil {
						sl.timer.Stop()
					}
					delete(ds.pairSlots, req.PairRef)
					continue
				}
				found, d = sl, ds
				break
			}
		} else {
			for ref, sl := range ds.pairSlots {
				if h.now().After(sl.deadline) {
					if sl.timer != nil {
						sl.timer.Stop()
					}
					delete(ds.pairSlots, ref)
					continue
				}
				found, d = sl, ds
				break
			}
		}
		if found != nil {
			break
		}
	}
	if found == nil {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "unpaired", Message: "no slot"})
		return
	}
	if found.bind != nil {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "pair_busy", Message: "pairing slot already attached"})
		return
	}
	rid, err := randRID()
	if err != nil {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "forbidden", Message: "relay entropy unavailable"})
		return
	}
	attemptSuffix, err := randHex(8)
	if err != nil {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "forbidden", Message: "relay entropy unavailable"})
		return
	}
	b := &bind{id: rid, client: st.conn, daemon: d, kind: kindPairing, created: h.now()}
	d.binds[rid] = b
	found.bind = b
	st.bind = b
	st.daemon = d
	st.mode = "pairing"
	if st.timer != nil {
		st.timer.Stop()
		st.timer = nil
	}
	h.armPairBindTimeoutLocked(b, h.pairFirstFrame, "pairing handshake did not start")
	client, daemonConn := st.conn, d.conn
	body := map[string]any{"v": 1, "attempt_id": "at_" + attemptSuffix, "route_id": hex.EncodeToString(rid[:]), "daemon_id": d.id, "pair_ref": found.ref}
	attached := envelope.JSON(envelope.TypPAIR_ATTACHED, rid, body)
	h.mu.Unlock()
	if err := client.Send(attached); err != nil {
		h.mu.Lock()
		pending := []pendingSend{}
		if d.binds[b.id] == b {
			pending = h.queueCloseBindLocked(b, routeErrFrame(b, "unpaired", "client send failed"), true)
		}
		h.mu.Unlock()
		flushPending(pending)
		return
	}
	if err := daemonConn.Send(attached); err != nil {
		h.mu.Lock()
		var pending []pendingSend
		if d.conn == daemonConn {
			pending = h.dropDaemonLocked(d)
		}
		h.mu.Unlock()
		flushPending(pending)
	}
}

// armPairBindTimeoutLocked bounds anonymous occupancy of the globally unique
// manual pairing slot. Only protocol progress, never PING, advances the timer.
func (h *Hub) armPairBindTimeoutLocked(b *bind, wait time.Duration, message string) {
	if b.timer != nil {
		b.timer.Stop()
	}
	b.timer = time.AfterFunc(wait, func() {
		h.mu.Lock()
		if b.daemon.binds[b.id] != b || b.kind != kindPairing {
			h.mu.Unlock()
			return
		}
		pending := h.queueCloseBindLocked(b, envelope.JSON(envelope.TypERROR, b.id, envelope.ErrorBody{
			Code: "pair_timeout", RouteID: hex.EncodeToString(b.id[:]), Message: message,
		}), true)
		h.mu.Unlock()
		flushPending(pending)
	})
}

func (h *Hub) clearPairSlotsLocked(d *daemonSlot) {
	for _, sl := range d.pairSlots {
		if sl.timer != nil {
			sl.timer.Stop()
		}
	}
	d.pairSlots = map[string]*pairSlot{}
}
