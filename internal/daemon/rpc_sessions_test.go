package daemon

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

// setupWithRuntime is setup(t) with a caller-supplied runtime instead of the
// always-Fake default, so ListSessions can be exercised against a real
// SessionLister.
func setupWithRuntime(t *testing.T, rt runtime.Runtime) (*Engine, *mux.Hub, *mux.Pipe, *mux.Pipe, chan struct{}, chan struct{}) {
	t.Helper()
	hub := mux.NewHub("pf_test")
	engA, hubD := mux.NewPipePair(32)
	eng := NewEngine(hub, engA, rt)
	eng.AutoAdmit = true
	stopD := pump(t, hubD, func(f envelope.Frame) { hub.HandleDaemon(hubD, f) })
	if err := eng.Register("pf_test"); err != nil {
		t.Fatal(err)
	}
	stopE := make(chan struct{})
	go eng.RecvLoop(stopE)
	return eng, hub, hubD, engA, stopD, stopE
}

func listenTestSocket(t *testing.T, socket string) {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			c, err := listener.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
}

func TestListSessionsUnsupportedWithFakeRuntime(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	self := seedClient(t, eng, hub)
	if err := self.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}

	_, err := self.RPC("ListSessions", map[string]any{})
	if err == nil || err.Error() != "unsupported" {
		t.Fatalf("want unsupported, got %v", err)
	}
}

func TestListSessionsRejectsUnknownParams(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	self := seedClient(t, eng, hub)
	if err := self.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}

	_, err := self.RPC("ListSessions", map[string]any{"unexpected": true})
	if err == nil || err.Error() != "unknown_op" {
		t.Fatalf("want unknown_op, got %v", err)
	}
}

func TestListSessionsReportsRunningAndStopped(t *testing.T) {
	configRoot, err := os.MkdirTemp("", "pfs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(configRoot) })
	sessionsDir := filepath.Join(configRoot, "sessions")
	if err := os.MkdirAll(filepath.Join(sessionsDir, "heydru"), 0o755); err != nil {
		t.Fatal(err)
	}
	listenTestSocket(t, filepath.Join(sessionsDir, "heydru", "herdr.sock"))

	h := runtime.NewHerdr(filepath.Join(configRoot, "herdr.sock"))
	h.ConfigRoot = configRoot
	h.Multi = true

	eng, hub, _, _, stopD, stopE := setupWithRuntime(t, h)
	defer close(stopD)
	defer close(stopE)

	self := seedClient(t, eng, hub)
	if err := self.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}

	raw, err := self.RPC("ListSessions", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Sessions []struct {
			Name    *string `json:"name"`
			Running bool    `json:"running"`
		} `json:"sessions"`
	}
	if json.Unmarshal(raw, &listed) != nil {
		t.Fatalf("list: %s", raw)
	}
	if len(listed.Sessions) != 2 {
		t.Fatalf("want default + heydru, got %s", raw)
	}
	if listed.Sessions[0].Name != nil || listed.Sessions[0].Running {
		t.Fatalf("default should be name:null, stopped: %s", raw)
	}
	if listed.Sessions[1].Name == nil || *listed.Sessions[1].Name != "heydru" || !listed.Sessions[1].Running {
		t.Fatalf("heydru should be present and running: %s", raw)
	}
}
