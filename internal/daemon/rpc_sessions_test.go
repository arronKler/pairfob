package daemon

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

func listenSessionSocket(t *testing.T, socket string) {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
}

func TestListSessionsUnsupportedWithFakeRuntime(t *testing.T) {
	_, client := runtimeRPCClient(t, runtime.NewFake())
	if _, err := client.RPC("ListSessions", map[string]any{}); err == nil || err.Error() != "unsupported" {
		t.Fatalf("want unsupported, got %v", err)
	}
	if _, err := client.RPC("ListSessions", map[string]any{"unexpected": true}); err == nil || err.Error() != "unknown_op" {
		t.Fatalf("want unknown_op for extra params, got %v", err)
	}
}

func TestListSessionsUnsupportedWithoutMultiSession(t *testing.T) {
	root, err := os.MkdirTemp("", "pfs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.MkdirAll(filepath.Join(root, "sessions", "work"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := runtime.NewHerdr(filepath.Join(root, "herdr.sock"))
	h.ConfigRoot = root
	_, client := runtimeRPCClient(t, h)
	// Session names stay private unless the operator opted in.
	if _, err := client.RPC("ListSessions", map[string]any{}); err == nil || err.Error() != "unsupported" {
		t.Fatalf("want unsupported, got %v", err)
	}
}

func TestListSessionsReportsRunningAndStopped(t *testing.T) {
	root, err := os.MkdirTemp("", "pfs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.MkdirAll(filepath.Join(root, "sessions", "work"), 0o755); err != nil {
		t.Fatal(err)
	}
	listenSessionSocket(t, filepath.Join(root, "sessions", "work", "herdr.sock"))
	h := runtime.NewHerdr(filepath.Join(root, "herdr.sock"))
	h.ConfigRoot = root
	h.Multi = true
	_, client := runtimeRPCClient(t, h)

	raw, err := client.RPC("ListSessions", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Sessions []struct {
			Name    *string `json:"name"`
			Running bool    `json:"running"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil || len(listed.Sessions) != 2 {
		t.Fatalf("want default + work: %s", raw)
	}
	if listed.Sessions[0].Name != nil || listed.Sessions[0].Running {
		t.Fatalf("default must be name:null and stopped: %s", raw)
	}
	if listed.Sessions[1].Name == nil || *listed.Sessions[1].Name != "work" || !listed.Sessions[1].Running {
		t.Fatalf("work must be listed and running: %s", raw)
	}
}

// sessionDescribeRuntime is offline for the default session and live for one
// named session, the case where GetConfig must describe the selected target.
type sessionDescribeRuntime struct {
	runtime.Runtime
	live      string
	described []string
}

func (r *sessionDescribeRuntime) Describe(ctx context.Context, s runtime.SessionRef) (runtime.Descriptor, error) {
	r.described = append(r.described, s.Name)
	if s.Name != r.live {
		return runtime.Descriptor{}, &runtime.Fault{Code: runtime.CodeOffline, Outcome: runtime.OutcomeNotApplied, SafeMessage: "offline"}
	}
	d, err := r.Runtime.Describe(ctx, s)
	d.Runtime = "herdr"
	return d, err
}

func TestGetConfigDescribesSelectedSession(t *testing.T) {
	rt := &sessionDescribeRuntime{Runtime: runtime.NewFake(), live: "work"}
	_, client := runtimeRPCClient(t, rt)

	// The default session is stopped: an old client's `{}` keeps failing closed.
	raw, err := client.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if config := decodeResult(t, raw); config["runtime"] != "offline" || config["capabilities"].(map[string]any)["create_tab"] != false {
		t.Fatalf("default session config: %s", raw)
	}

	raw, err = client.RPC("GetConfig", map[string]any{"session": "work"})
	if err != nil {
		t.Fatal(err)
	}
	config := decodeResult(t, raw)
	if config["runtime"] != "herdr" || config["capabilities"].(map[string]any)["create_tab"] != true {
		t.Fatalf("named session config must advertise its capabilities: %s", raw)
	}
	if len(config["agent_kinds"].([]any)) == 0 {
		t.Fatalf("named session config must list its agent kinds: %s", raw)
	}

	if _, err := client.RPC("GetConfig", map[string]any{"session": nil}); err != nil {
		t.Fatalf("null session selects the default: %v", err)
	}
	if got := strings.Join(rt.described, ","); got != ",work," {
		t.Fatalf("described sessions %q", got)
	}
	for _, bad := range []map[string]any{{"session": "../x"}, {"session": "work", "extra": 1}} {
		if _, err := client.RPC("GetConfig", bad); err == nil || err.Error() != "unknown_op" {
			t.Fatalf("GetConfig %v: want unknown_op, got %v", bad, err)
		}
	}
}

// The PWA shows the switch only when GetConfig advertises list_sessions, so
// the key follows the opt-in alone. In particular it must stay true while the
// default Herdr server is down (no socket here at all), or a user whose only
// running server is a named one could never reach it.
func TestGetConfigAdvertisesListSessionsWithTheOptIn(t *testing.T) {
	for _, multi := range []bool{false, true} {
		root := t.TempDir()
		h := runtime.NewHerdr(filepath.Join(root, "herdr.sock"))
		h.ConfigRoot = root
		h.Multi = multi
		_, client := runtimeRPCClient(t, h)
		raw, err := client.RPC("GetConfig", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		config := decodeResult(t, raw)
		if config["runtime"] != "offline" {
			t.Fatalf("default server must be down in this fixture: %s", raw)
		}
		if got := config["capabilities"].(map[string]any)["list_sessions"]; got != multi {
			t.Fatalf("multi=%v: list_sessions=%v: %s", multi, got, raw)
		}
	}
}
