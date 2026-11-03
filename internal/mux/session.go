package mux

import (
	"encoding/hex"
	"time"

	"pairfob/internal/envelope"
)

func (h *Hub) clientHello(st *clientState, f envelope.Frame) {
	var req struct {
		V        int `json:"v"`
		Protocol int `json:"protocol"`
	}
	if !isZeroRID(f.RouteID) || decodeJSON(f.Payload, &req) != nil || req.V != 1 || req.Protocol != 1 {
		h.reject(st.conn, "bad_token", "invalid HELLO_CLIENT payload")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if st.hello {
		h.sendErr(st.conn, envelope.ErrorBody{Code: "unbound", Message: "duplicate HELLO_CLIENT"})
		st.conn.Close()
		return
	}
	st.hello = true
	st.helloAt = h.now()
	st.timer = time.AfterFunc(h.helloGrace, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if current := h.clients[st.conn]; current == st && st.mode == "" {
			h.sendErr(st.conn, envelope.ErrorBody{Code: "unbound", Message: "5s attach timeout"})
			st.conn.Close()
			delete(h.clients, st.conn)
		}
	})
}

func (h *Hub) sessionAttach(st *clientState, f envelope.Frame) {
	var req struct {
		V        int    `json:"v"`
		DaemonID string `json:"daemon_id"`
	}
	if !isZeroRID(f.RouteID) || decodeJSON(f.Payload, &req) != nil || req.V != 1 || !daemonIDPattern.MatchString(req.DaemonID) {
		h.reject(st.conn, "bad_token", "invalid SESSION_ATTACH payload")
		return
	}
	h.mu.Lock()
	if !st.hello || h.now().Sub(st.helloAt) > h.helloGrace {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "unbound", Message: "SESSION_ATTACH after HELLO timeout"})
		st.conn.Close()
		return
	}
	if st.mode == "pairing" {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "wrong_ws", Message: "SESSION_ATTACH on PairingWS"})
		return
	}
	if st.bind != nil || st.mode == "session" {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "wrong_ws", Message: "SessionWS already attached"})
		return
	}
	d := h.daemons[req.DaemonID]
	if d == nil || d.conn == nil {
		h.mu.Unlock()
		h.sendErr(st.conn, envelope.ErrorBody{Code: "daemon_offline", Message: "no daemon"})
		return
	}
	var pending []pendingSend
	_, nResume := countKinds(d)
	if nResume >= 2 {
		var lru *bind
		for _, b := range d.binds {
			if b.kind == kindResumeHello && (lru == nil || b.created.Before(lru.created)) {
				lru = b
			}
		}
		if lru != nil {
			pending = append(pending, h.kickBindLocked(lru, "kicked", "replaced LRU ResumeHello")...)
		}
	}
	rid, err := randRID()
	if err != nil {
		h.mu.Unlock()
		flushPending(pending)
		h.sendErr(st.conn, envelope.ErrorBody{Code: "forbidden", Message: "relay entropy unavailable"})
		return
	}
	b := &bind{id: rid, client: st.conn, daemon: d, kind: kindResumeHello, created: h.now()}
	b.timer = time.AfterFunc(h.resumeWait, func() {
		h.mu.Lock()
		var late []pendingSend
		if b.kind == kindResumeHello && b.daemon.binds[b.id] == b {
			late = h.queueCloseBindLocked(b, routeErrFrame(b, "unpaired", "15s DeviceHello timeout"), true)
		}
		h.mu.Unlock()
		flushPending(late)
	})
	d.binds[rid] = b
	st.bind = b
	st.daemon = d
	st.mode = "session"
	if st.timer != nil {
		st.timer.Stop()
		st.timer = nil
	}
	client, daemonConn := st.conn, d.conn
	body := map[string]any{"v": 1, "route_id": hex.EncodeToString(rid[:])}
	bound := envelope.JSON(envelope.TypSESSION_BOUND, rid, body)
	h.mu.Unlock()
	flushPending(pending)
	if err := client.Send(bound); err != nil {
		h.mu.Lock()
		var fail []pendingSend
		if d.binds[b.id] == b {
			fail = h.queueCloseBindLocked(b, routeErrFrame(b, "unpaired", "client send failed"), true)
		}
		h.mu.Unlock()
		flushPending(fail)
		return
	}
	if err := daemonConn.Send(bound); err != nil {
		h.mu.Lock()
		var fail []pendingSend
		if d.conn == daemonConn {
			fail = h.dropDaemonLocked(d)
		}
		h.mu.Unlock()
		flushPending(fail)
	}
}

func (h *Hub) sessionEstablished(c Conn, f envelope.Frame) {
	var req struct {
		V       int    `json:"v"`
		RouteID string `json:"route_id"`
	}
	wantRID := hex.EncodeToString(f.RouteID[:])
	if isZeroRID(f.RouteID) || decodeJSON(f.Payload, &req) != nil || req.V != 1 || req.RouteID != wantRID {
		h.sendRouteErr(c, f.RouteID, envelope.ErrorBody{Code: "unbound", RouteID: wantRID, Message: "SESSION_ESTABLISHED route mismatch"})
		return
	}
	h.mu.Lock()
	d := h.daemonByConn(c)
	if d == nil {
		h.mu.Unlock()
		return
	}
	b := d.binds[f.RouteID]
	if b == nil || b.kind != kindResumeHello {
		h.mu.Unlock()
		h.sendRouteErr(c, f.RouteID, envelope.ErrorBody{Code: "unbound", RouteID: wantRID, Message: "route is not ResumeHello"})
		return
	}
	nEst, _ := countKinds(d)
	if nEst >= 10 {
		pending := h.queueCloseBindLocked(b, routeErrFrame(b, "too_many_devices", "established cap 10"), true)
		h.mu.Unlock()
		flushPending(pending)
		return
	}
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.kind = kindEstablished
	client := b.client
	h.mu.Unlock()
	if err := client.Send(f); err != nil {
		h.mu.Lock()
		var pending []pendingSend
		if d.binds[b.id] == b {
			pending = h.queueCloseBindLocked(b, routeErrFrame(b, "unpaired", "client send failed"), true)
		}
		h.mu.Unlock()
		flushPending(pending)
	}
}

func (h *Hub) errorFromDaemon(c Conn, f envelope.Frame) {
	var body envelope.ErrorBody
	if decodeJSON(f.Payload, &body) != nil || body.Code == "" {
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "invalid ERROR payload"})
		return
	}
	h.mu.Lock()
	d := h.daemonByConn(c)
	if d == nil {
		h.mu.Unlock()
		return
	}
	var pending []pendingSend
	if body.RouteID != "" {
		if !isLowerHex(body.RouteID, 16) || body.RouteID != hex.EncodeToString(f.RouteID[:]) {
			h.mu.Unlock()
			h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "ERROR route mismatch"})
			return
		}
		if b := d.binds[f.RouteID]; b != nil {
			pending = h.queueCloseBindLocked(b, f, false)
		}
		h.mu.Unlock()
		flushPending(pending)
		return
	}
	if !isZeroRID(f.RouteID) {
		h.mu.Unlock()
		h.sendErr(c, envelope.ErrorBody{Code: "bad_token", Message: "ERROR missing route_id payload"})
		return
	}
	for _, b := range d.binds {
		pending = append(pending, pendingSend{c: b.client, f: f})
	}
	h.mu.Unlock()
	flushPending(pending)
}

func countKinds(d *daemonSlot) (est, resume int) {
	for _, b := range d.binds {
		switch b.kind {
		case kindEstablished:
			est++
		case kindResumeHello:
			resume++
		}
	}
	return
}

// BindKindCounts is the live mux table (tests assert ResumeHello cap).
func (h *Hub) BindKindCounts(daemonID string) (established, resumeHello int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	d := h.daemons[daemonID]
	if d == nil {
		return 0, 0
	}
	return countKinds(d)
}
