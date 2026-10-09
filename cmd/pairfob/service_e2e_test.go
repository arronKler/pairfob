package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"pairfob/internal/admin"
	"pairfob/internal/envelope"
	"pairfob/internal/state"
	"pairfob/internal/wsnet"
)

// Opt in with PAIRFOB_REAL_SERVICE_E2E=1 and PAIRFOB_E2E_BINARY pointing
// at a binary built from this checkout for the current OS. Requires a live
// launchd GUI domain or systemd user manager. Only the unique test unit is
// installed and removed; the user's Pairfob service is never controlled.
func TestRealServiceRecovery(t *testing.T) {
	if os.Getenv("PAIRFOB_REAL_SERVICE_E2E") != "1" {
		t.Skip("real user-service lifecycle is opt-in")
	}
	binary, err := filepath.EvalSymlinks(os.Getenv("PAIRFOB_E2E_BINARY"))
	if err != nil || !filepath.IsAbs(binary) {
		t.Fatalf("PAIRFOB_E2E_BINARY must be an existing absolute executable: %v", err)
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "pf-e2e-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	sock := filepath.Join(dir, "pairfob.sock")
	t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
	t.Setenv("PAIRFOB_HERDR_AUTOSTART", "0")
	t.Setenv("HERDR_SOCKET_PATH", filepath.Join(dir, "missing-herdr.sock"))
	for _, key := range []string{"PAIRFOB_ORIGIN", "PAIRFOB_RELAY_WS", "PAIRFOB_JOIN_TOKEN", "PAIRFOB_JOIN_GRANT", "PAIRFOB_PROTOCOL", "PAIRFOB_DEV_FAKE_RUNTIME", "PAIRFOB_PAIR_CODE", inheritedServiceLock} {
		t.Setenv(key, "")
	}
	layout, err := currentServiceLayout()
	if err != nil {
		t.Fatal(err)
	}
	name := "pairfob-e2e-" + filepath.Base(dir)
	layout.ExecPath = binary
	if runtime.GOOS == "darwin" {
		layout.LaunchdLabel = "com.pairfob." + name
		layout.UnitPath = filepath.Join(dir, layout.LaunchdLabel+".plist")
	} else {
		layout.SystemdUnit = name + ".service"
		// The real manager searches the logged-in user's config directory,
		// independently of the temporary HOME used by the daemon.
		layout.UnitPath = filepath.Join(userHome, ".config", "systemd", "user", layout.SystemdUnit)
	}
	if _, err := os.Stat(layout.UnitPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("test unit already exists or cannot be inspected: %v", err)
	}
	manager := runServiceCommand
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		// Production unit bytes remain unchanged. Change only the fixture's
		// Label before its first bootstrap, so launchd uses the isolated name.
		if layout.GOOS == "darwin" && len(args) == 4 && args[1] == "bootstrap" {
			body, err := os.ReadFile(layout.UnitPath)
			if err != nil {
				return nil, err
			}
			body = bytes.Replace(body, []byte("<string>"+launchdLabel+"</string>"), []byte("<string>"+layout.LaunchdLabel+"</string>"), 1)
			if err := os.WriteFile(layout.UnitPath, body, 0600); err != nil {
				return nil, err
			}
		}
		if args[1] != "print" && !(len(args) > 2 && args[2] == "show") {
			t.Logf("real manager: %s", strings.Join(args, " "))
		}
		return manager(args)
	})
	t.Cleanup(func() {
		if err := uninstallServiceLayout(layout); err != nil {
			t.Errorf("remove test service %s: %v", layout.UnitPath, err)
		}
		if err := os.Remove(layout.UnitPath + ".control-lock"); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Error(err)
		}
	})
	store, err := state.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	const daemonID = "d_0123456789abcdef0123"
	const token = "rt_0123456789abcdef0123456789abcdef"
	relay := realServiceRelay(t, daemonID, token)
	if err := store.SaveRelay(state.Relay{URL: "ws" + strings.TrimPrefix(relay.URL, "http") + "/v2/ws?daemon_id=" + daemonID, Protocol: 2, ReconnectToken: token}); err != nil {
		t.Fatal(err)
	}
	assertHint := func(note, command string) {
		t.Helper()
		if hint := recoveryHint(layout, nil); hint.Note != note || hint.Command != command {
			t.Fatalf("recovery hint=%+v", hint)
		}
	}
	assertHint("service not installed", "pairfob service install")
	if err := withServiceLock(layout, func() error { return installUserServiceLayout(layout) }); err != nil {
		log, _ := os.ReadFile(layout.LogPath)
		t.Fatalf("install: %v\ndaemon log: %s", err, log)
	}
	process := func() admin.ProcessInfo {
		t.Helper()
		p, err := inspectLocalProcess(sock)
		if err != nil {
			t.Fatal(err)
		}
		defer p.peer.Close()
		status, err := observeService(layout)
		if err != nil || status.State != "running" || status.PID != p.info.PID || p.info.Executable != binary {
			t.Fatalf("manager and daemon differ: %+v %+v %v", status, p.info, err)
		}
		return p.info
	}
	installed := process()
	t.Logf("install ready: PID=%d instance=%s", installed.PID, installed.Instance)
	var snapshot bytes.Buffer
	if err := runBareCommand(&snapshot, sock, true); err != nil || !strings.Contains(snapshot.String(), "Pairfob is running.") {
		t.Fatalf("TTY live status: %s %v", snapshot.String(), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binary, "run").CombinedOutput()
	if err == nil || !strings.Contains(string(out), "already running") {
		t.Fatalf("duplicate foreground run: %s %v", out, err)
	}
	// Temporarily hide this test socket while the real service remains running.
	if err := os.Rename(sock, sock+".hidden"); err != nil {
		t.Fatal(err)
	}
	func() {
		defer func() {
			if err := os.Rename(sock+".hidden", sock); err != nil {
				t.Error(err)
			}
		}()
		if daemonIsLive(sock) {
			t.Fatal("hidden socket is still answering")
		}
		assertHint("service running but not answering", "pairfob service restart")
	}()
	if err := applyService(layout, "stop"); err != nil {
		t.Fatal(err)
	}
	if err := waitForProcessExit(installed.PID); err != nil {
		t.Fatal(err)
	}
	assertHint("service stopped", "pairfob service start")
	if err := ensureInstalledService(layout, false); err != nil {
		t.Fatalf("start: %v", err)
	}
	started := process()
	if started.Instance == installed.Instance {
		t.Fatal("start reused the stopped instance")
	}
	t.Logf("start ready: PID=%d instance=%s", started.PID, started.Instance)
	if err := ensureInstalledService(layout, true); err != nil {
		t.Fatalf("restart: %v", err)
	}
	restarted := process()
	if restarted.Instance == started.Instance || restarted.PID == started.PID {
		t.Fatal("restart did not replace the daemon")
	}
	t.Logf("restart ready: PID=%d instance=%s", restarted.PID, restarted.Instance)
}

// Only the relay handshake is a loopback fixture. The candidate daemon, admin
// socket, service unit and launchctl/systemctl commands are real.
func realServiceRelay(t *testing.T, daemonID, token string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/config" {
			fmt.Fprint(w, `{"protocol":2}`)
			return
		}
		upgrader := wsnet.UpgraderFor(wsnet.SubprotocolV2)
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := wsnet.Wrap(ws)
		defer conn.Close()
		frame, err := conn.Recv()
		if err != nil || frame.Typ != envelope.TypHELLO_DAEMON {
			return
		}
		if err := conn.Send(envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{"ok": true, "daemon_id": daemonID, "reconnect_token": token})); err != nil {
			return
		}
		for {
			if _, err := conn.Recv(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	return server
}
