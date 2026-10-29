package daemon

import (
	"encoding/json"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestIdleSinceTracksDispatchedRPC(t *testing.T) {
	eng := NewEngine(nil, nil, runtime.NewFake())
	if idle := eng.IdleSince(); idle < 100*365*24*time.Hour {
		t.Fatalf("fresh engine IdleSince = %v, want a very large duration", idle)
	}
	s := &sess{routeID: [16]byte{1}, deviceID: "dev_12345678", state: "established"}
	eng.dispatch(s, "req_ping", "Ping", json.RawMessage(`{"t_ms":1}`))
	if idle := eng.IdleSince(); idle > time.Minute {
		t.Fatalf("IdleSince after dispatch = %v, want a small duration", idle)
	}
}
