package mux

import "pairfob/internal/envelope"

// AcceptsJoinToken reports whether token matches the join credential active in
// this process. It is used only to distinguish a freshly bootstrapped token
// from an already-persisted rotation at startup.
func (h *Hub) AcceptsJoinToken(token string) bool {
	return token != "" && tokenHash(token) == h.joinHash
}

func (h *Hub) registerDaemon(c Conn, f envelope.Frame) {
	var req struct {
		V              int     `json:"v"`
		Op             string  `json:"op"`
		JoinToken      string  `json:"join_token"`
		DaemonID       *string `json:"daemon_id"`
		ReconnectToken *string `json:"reconnect_token"`
	}
	if !isZeroRID(f.RouteID) {
		h.reject(c, "bad_token", "HELLO_DAEMON route_id must be zero")
		return
	}
	if err := decodeJSON(f.Payload, &req); err != nil || req.V != 1 || req.Op != "RegisterDaemon" {
		h.reject(c, "bad_token", "invalid RegisterDaemon payload")
		return
	}
	h.mu.Lock()
	if h.daemonByConn(c) != nil {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "unbound", Message: "daemon websocket already registered"})
		return
	}
	if req.JoinToken != "" {
		if tokenHash(req.JoinToken) != h.joinHash {
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "join"})
			return
		}
		if req.DaemonID != nil && *req.DaemonID != "" {
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "join cannot reuse daemon_id"})
			return
		}
		if req.ReconnectToken != nil && *req.ReconnectToken != "" {
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "join and reconnect are mutually exclusive"})
			return
		}
		idSuffix, err := randHex(10)
		if err != nil {
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "forbidden", Message: "relay entropy unavailable"})
			return
		}
		tokenSuffix, err := randHex(16)
		if err != nil {
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "forbidden", Message: "relay entropy unavailable"})
			return
		}
		id := "d_" + idSuffix
		rt := "rt_" + tokenSuffix
		slot := &daemonSlot{id: id, conn: c, reconnectToken: rt, binds: map[[16]byte]*bind{}, pairSlots: map[string]*pairSlot{}}
		h.daemons[id] = slot
		h.reconnect[tokenHash(rt)] = id
		if err := h.persistReconnectRegistryLocked(); err != nil {
			delete(h.reconnect, tokenHash(rt))
			delete(h.daemons, id)
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "forbidden", Message: "relay state unavailable"})
			return
		}
		ack := envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
			"v": 1, "op": "RegisterDaemon", "ok": true, "daemon_id": id, "reconnect_token": rt, "relay_time": h.now().Unix(),
		})
		h.mu.Unlock()
		_ = c.Send(ack)
		return
	}
	if req.DaemonID == nil || req.ReconnectToken == nil {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "need reconnect"})
		return
	}
	if !daemonIDPattern.MatchString(*req.DaemonID) || !reconnectTokenPattern.MatchString(*req.ReconnectToken) {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "invalid reconnect credentials"})
		return
	}
	want, ok := h.reconnect[tokenHash(*req.ReconnectToken)]
	if !ok || want != *req.DaemonID {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "reconnect"})
		return
	}
	slot := h.daemons[*req.DaemonID]
	var pending []pendingSend
	var old Conn
	if slot != nil && slot.conn != nil && slot.conn != c {
		old = slot.conn
		for _, b := range slot.binds {
			pending = append(pending, h.queueCloseBindLocked(b, envelope.JSON(envelope.TypDAEMON_REPLACED, b.id, map[string]any{"v": 1, "daemon_id": slot.id}), false)...)
		}
		slot.binds = map[[16]byte]*bind{}
		h.clearPairSlotsLocked(slot)
	}
	if slot == nil {
		slot = &daemonSlot{id: *req.DaemonID, binds: map[[16]byte]*bind{}, pairSlots: map[string]*pairSlot{}}
		h.daemons[slot.id] = slot
	}
	slot.conn = c
	slot.reconnectToken = *req.ReconnectToken
	ack := envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
		"v": 1, "op": "RegisterDaemon", "ok": true, "daemon_id": slot.id, "reconnect_token": slot.reconnectToken, "relay_time": h.now().Unix(),
	})
	h.mu.Unlock()
	flushPending(pending)
	if old != nil {
		old.Close()
	}
	_ = c.Send(ack)
}
