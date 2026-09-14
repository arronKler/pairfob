package runtime

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// shortTestDir returns a short-named temp directory directly under the OS
// temp root. Unix socket paths are limited to ~104 bytes on macOS, and
// shortTestDir(t) embeds the full test name, which is long enough to blow that
// limit once a "sessions/<name>/herdr.sock" suffix is appended.
func shortTestDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "pfs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
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

func TestSessionsDisabledWithoutMulti(t *testing.T) {
	h := &Herdr{Socket: filepath.Join(shortTestDir(t), "default.sock"), ConfigRoot: shortTestDir(t)}
	_, err := h.Sessions(context.Background())
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeUnsupported {
		t.Fatalf("want CodeUnsupported, got %v", err)
	}
}

func TestSessionsAlwaysIncludesDefault(t *testing.T) {
	configRoot := shortTestDir(t)
	socket := filepath.Join(configRoot, "herdr.sock")
	h := &Herdr{Socket: socket, ConfigRoot: configRoot, Multi: true}

	sessions, err := h.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Name != "" || sessions[0].Running {
		t.Fatalf("want one stopped default session, got %+v", sessions)
	}

	listenTestSocket(t, socket)
	sessions, err = h.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Name != "" || !sessions[0].Running {
		t.Fatalf("want one running default session, got %+v", sessions)
	}
}

func TestSessionsReportsRunningAndStoppedNamedSessions(t *testing.T) {
	configRoot := shortTestDir(t)
	h := &Herdr{Socket: filepath.Join(configRoot, "herdr.sock"), ConfigRoot: configRoot, Multi: true}

	sessionsDir := filepath.Join(configRoot, "sessions")
	for _, name := range []string{"heydru", "derecho"} {
		if err := os.MkdirAll(filepath.Join(sessionsDir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// heydru is live; derecho's directory exists but nothing is listening.
	listenTestSocket(t, filepath.Join(sessionsDir, "heydru", "herdr.sock"))

	sessions, err := h.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 3 {
		t.Fatalf("want default + 2 named sessions, got %+v", sessions)
	}
	byName := map[string]SessionInfo{}
	for _, s := range sessions {
		byName[s.Name] = s
	}
	if s, ok := byName[""]; !ok || s.Running {
		t.Fatalf("default should be present and stopped: %+v", byName)
	}
	if s, ok := byName["heydru"]; !ok || !s.Running {
		t.Fatalf("heydru should be present and running: %+v", byName)
	}
	if s, ok := byName["derecho"]; !ok || s.Running {
		t.Fatalf("derecho should be present and stopped: %+v", byName)
	}
	// default first, then alphabetical.
	if sessions[0].Name != "" || sessions[1].Name != "derecho" || sessions[2].Name != "heydru" {
		t.Fatalf("unexpected order: %+v", sessions)
	}
}

func TestSessionsExcludesNonConformingDirectoryNames(t *testing.T) {
	configRoot := shortTestDir(t)
	h := &Herdr{Socket: filepath.Join(configRoot, "herdr.sock"), ConfigRoot: configRoot, Multi: true}

	sessionsDir := filepath.Join(configRoot, "sessions")
	for _, name := range []string{"ok-name", "not valid name", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(sessionsDir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// A stray file (not a directory) alongside the session directories.
	if err := os.WriteFile(filepath.Join(sessionsDir, "not-a-dir"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	sessions, err := h.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, s := range sessions {
		names[s.Name] = true
	}
	if !names["ok-name"] {
		t.Fatalf("valid name excluded: %+v", sessions)
	}
	if names["not valid name"] || names["not-a-dir"] {
		t.Fatalf("invalid entries leaked through: %+v", sessions)
	}
}

func TestSessionsToleratesMissingSessionsDirectory(t *testing.T) {
	configRoot := shortTestDir(t)
	h := &Herdr{Socket: filepath.Join(configRoot, "herdr.sock"), ConfigRoot: configRoot, Multi: true}
	sessions, err := h.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Name != "" {
		t.Fatalf("want default-only when sessions dir is absent, got %+v", sessions)
	}
}
