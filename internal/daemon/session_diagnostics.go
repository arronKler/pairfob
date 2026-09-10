package daemon

import (
	"encoding/hex"

	"pairfob/internal/mux"
)

// DirectCloseInfo is content-free evidence supplied by a local transport adapter.
// Reason describes what this endpoint observed, not an inferred remote cause.
type DirectCloseInfo struct {
	Reason        string
	ErrorClass    string
	ICEState      string
	PeerState     string
	ChannelState  string
	BufferedBytes uint64
	LifetimeMS    int64
}

type directCloseReporter interface{ CloseInfo() DirectCloseInfo }

type sessionCloseRecord struct {
	deviceID  string
	routeID   [16]byte
	transport string
	state     string
	link      mux.Conn
}

// Snapshot under Engine.mu; collect transport details and write the audit only
// after releasing it, since adapters have their own synchronization.
func captureSessionClose(s *sess) sessionCloseRecord {
	return sessionCloseRecord{s.deviceID, s.routeID, s.transport, s.state, s.link}
}

func (e *Engine) auditSessionClose(event, reason, code string, record sessionCloseRecord) {
	fields := map[string]any{
		"device_id": record.deviceID, "route_id": hex.EncodeToString(record.routeID[:]),
		"transport": record.transport, "state": record.state, "reason": reason, "build": e.Build,
	}
	if code != "" {
		fields["code"] = code
	}
	if reporter, ok := record.link.(directCloseReporter); ok {
		info := reporter.CloseInfo()
		if info.Reason != "" {
			fields["transport_reason"] = info.Reason
		}
		if info.ErrorClass != "" {
			fields["error_class"] = info.ErrorClass
		}
		fields["ice_state"] = info.ICEState
		fields["peer_state"] = info.PeerState
		fields["channel_state"] = info.ChannelState
		fields["buffered_bytes"] = info.BufferedBytes
		fields["connection_age_ms"] = info.LifetimeMS
	}
	e.audit(event, fields)
}

func closeDirectConnection(conn mux.Conn, reason string) {
	if closer, ok := conn.(interface{ CloseWithReason(string) }); ok {
		closer.CloseWithReason(reason)
	} else {
		conn.Close()
	}
}
