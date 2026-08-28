package mux

import (
	"time"

	"pairfob/internal/envelope"
)

func (h *Hub) fwdFromDaemon(c Conn, f envelope.Frame) {
	h.mu.Lock()
	d := h.daemonByConn(c)
	if d == nil {
		h.mu.Unlock()
		return
	}
	b := d.binds[f.RouteID]
	if b == nil {
		h.mu.Unlock()
		return
	}
	f.RouteID = b.id
	h.mu.Unlock()
	if err := b.client.Send(f); err != nil {
		h.mu.Lock()
		var pending []pendingSend
		if d.binds[b.id] == b {
			pending = h.queueCloseBindLocked(b, routeErrFrame(b, "unpaired", "client send failed"), true)
		}
		h.mu.Unlock()
		flushPending(pending)
	}
}

func (h *Hub) fwdFromClient(st *clientState, f envelope.Frame) {
	h.mu.Lock()
	if st.bind == nil || st.daemon == nil || st.daemon.conn == nil {
		h.sendErr(st.conn, envelope.ErrorBody{Code: "unbound", Message: "FWD before bind"})
		st.conn.Close()
		h.mu.Unlock()
		return
	}
	f.RouteID = st.bind.id
	if st.bind.kind == kindPairing {
		st.bind.pairFrames++
		if st.bind.pairFrames == 1 {
			h.armPairBindTimeoutLocked(st.bind, h.pairConfirmWait, "pairing proof did not arrive")
		} else if st.bind.pairFrames == 2 {
			remaining := h.ttlPair
			if remaining <= 0 {
				remaining = 180 * time.Second
			}
			h.armPairBindTimeoutLocked(st.bind, remaining, "pairing confirmation timed out")
		}
	}
	d := st.daemon
	daemonConn := d.conn
	h.mu.Unlock()
	if err := daemonConn.Send(f); err != nil {
		h.mu.Lock()
		var pending []pendingSend
		if d.conn == daemonConn {
			pending = h.dropDaemonLocked(d)
		}
		h.mu.Unlock()
		flushPending(pending)
	}
}
