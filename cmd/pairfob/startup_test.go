package main

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"

	"pairfob/internal/admin"
	"pairfob/internal/daemon"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

func TestBareTTYLiveShowsSnapshot(t *testing.T) {
	t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
	t.Setenv("HERDR_SOCKET_PATH", testSocket(t))
	// Keep health gathering local; an unavailable origin does not hide status.
	t.Setenv("PAIRFOB_ORIGIN", "invalid")
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		t.Fatalf("live status queried service: %v", args)
		return nil, nil
	})
	a, _ := mux.NewPipePair(8)
	t.Cleanup(func() { a.Close() })
	eng := daemon.NewEngine(nil, a, runtime.NewFake())
	eng.PutDevice("dev_12345678", []byte("01234567890123456789012345678901"))
	sock := startLiveAdmin(t, eng)
	t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
	var out bytes.Buffer
	if err := runBareCommand(&out, sock, true); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Pairfob is running.", "1 device paired.", "pairfob doctor"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
}

func TestBareTTYOfflineExitsWithoutStartingDaemon(t *testing.T) {
	for _, test := range []struct {
		name, home, note, advice string
		foregroundAlternative    bool
	}{
		{"service", t.TempDir(), "service not installed", "Install the login service: pairfob service install", true},
		{"foreground", "", "service unavailable", "Run it in the foreground: pairfob run", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("HOME", test.home)
			stateDir := t.TempDir()
			t.Setenv("PAIRFOB_STATE_DIR", stateDir)
			sock := testSocket(t)
			t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
			// If status regresses into startup, fail locally before enrollment.
			t.Setenv("PAIRFOB_PROTOCOL", "invalid")
			t.Setenv("PAIRFOB_DEV_FAKE_RUNTIME", "1")
			var out bytes.Buffer
			err := runBareCommand(&out, sock, true)
			if !errors.Is(err, admin.ErrNotRunning) {
				t.Fatalf("got %v", err)
			}
			for _, want := range []string{"isn't running", test.note, test.advice} {
				if !strings.Contains(out.String(), want) {
					t.Fatalf("missing %q in %s", want, out.String())
				}
			}
			if strings.Contains(out.String(), "Run in the foreground: pairfob run") != test.foregroundAlternative {
				t.Fatalf("unexpected foreground alternative: %s", out.String())
			}
			if strings.Count(out.String(), "pairfob run") != 1 {
				t.Fatalf("foreground command must appear once: %s", out.String())
			}
			if _, err := os.Stat(sock); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("admin socket created: %v", err)
			}
			if entries, err := os.ReadDir(stateDir); err != nil || len(entries) != 0 {
				t.Fatalf("status created daemon state: %v %v", entries, err)
			}
		})
	}
}

func TestForegroundCommandsRefuseExistingDaemon(t *testing.T) {
	for _, name := range []string{"run", "bare non-TTY live", "bare non-TTY starting"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
			var sock string
			if name == "bare non-TTY live" {
				sock = startAdminService(t, &interactiveAdmin{})
			} else {
				sock = testSocket(t)
				ln, err := admin.Listen(sock)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = ln.Close() })
			}
			t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
			var out bytes.Buffer
			var err error
			if name == "run" {
				err = runCommand([]string{"run"}, sock)
			} else {
				err = runBareCommand(&out, sock, false)
			}
			if err == nil || !strings.Contains(err.Error(), "already running") {
				t.Fatalf("foreground command did not attempt daemon startup: %v", err)
			}
			if out.Len() != 0 {
				t.Fatalf("foreground command displayed status: %s", out.String())
			}
		})
	}
}
