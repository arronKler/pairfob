package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/audit"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

type diagnosticTestConn struct{ mux.Conn }

func (c *diagnosticTestConn) CloseInfo() DirectCloseInfo {
	return DirectCloseInfo{Reason: "data_channel_error", ErrorClass: "eof", ICEState: "disconnected", PeerState: "connected", ChannelState: "open", BufferedBytes: 123, LifetimeMS: 13000}
}

func TestDirectCloseAuditCorrelatesRouteAndFirstCause(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	logger, err := audit.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	relay, _ := mux.NewPipePair(16)
	direct, _ := mux.NewPipePair(16)
	link := &diagnosticTestConn{direct}
	e := NewEngine(nil, relay, runtime.NewFake())
	e.Audit, e.Build = logger, "test-build"
	route := [16]byte{1}
	e.sessions[route] = &sess{routeID: route, deviceID: "test-device", state: "established", transport: "p2p", link: link}
	e.byDevice["test-device"] = route
	e.handleDirectClose(route, link)
	e.handleDirectClose(route, link) // Duplicate callbacks must not emit a second disconnect.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("want session_closed and p2p_closed, got %s", data)
	}
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatal(err)
		}
		for key, want := range map[string]any{"reason": "direct_transport_closed", "transport_reason": "data_channel_error", "error_class": "eof", "route_id": "01000000000000000000000000000000", "state": "established", "build": "test-build", "buffered_bytes": float64(123)} {
			if record[key] != want {
				t.Fatalf("%s = %v, want %v", key, record[key], want)
			}
		}
	}
}

func TestRelayResetAuditDoesNotReportEstablishedDirectAsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	logger, err := audit.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer logger.Close()
	relay, _ := mux.NewPipePair(16)
	e := NewEngine(nil, relay, runtime.NewFake())
	e.Audit = logger
	for i, kind := range []string{"relay", "p2p"} {
		route := [16]byte{byte(i + 1)}
		e.sessions[route] = &sess{routeID: route, deviceID: kind, state: "established", transport: kind, link: relay}
	}
	e.ResetTransport()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(strings.Split(strings.TrimSpace(string(data)), "\n")[0]), &record); err != nil {
		t.Fatalf("expected one record: %v: %s", err, data)
	}
	if record["reason"] != "relay_transport_reset" || record["transport"] != "relay" || record["state"] != "established" {
		t.Fatalf("wrong evidence: %s", data)
	}
	if len(e.sessions) != 1 {
		t.Fatal("direct session was lost")
	}
}
