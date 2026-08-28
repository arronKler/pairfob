package runtime

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEnsureHerdrServerLeavesLiveServerAlone(t *testing.T) {
	socket, _ := startScriptedHerdr(t, standardReply)
	herdr := NewHerdr(socket)
	herdr.launchServer = func(context.Context, string, string, string) (<-chan error, error) {
		t.Fatal("live Herdr must not launch another server")
		return nil, nil
	}

	availability, err := herdr.EnsureServer(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if availability.Started || availability.Descriptor.Protocol != 19 {
		t.Fatalf("availability=%+v", availability)
	}
}

func TestEnsureHerdrServerStartsAndWaitsForLiveAPI(t *testing.T) {
	socket := shortTestSocket(t)
	herdr := NewHerdr(socket)
	herdr.TerminalBinary = "/opt/herdr/bin/herdr"
	herdr.bootstrapPoll = time.Millisecond
	var launches atomic.Int32
	herdr.launchServer = func(_ context.Context, binary, startupDir, requestedSocket string) (<-chan error, error) {
		launches.Add(1)
		if binary != herdr.TerminalBinary {
			t.Errorf("binary=%q", binary)
		}
		if startupDir == "" || !filepath.IsAbs(startupDir) {
			t.Errorf("startupDir=%q", startupDir)
		}
		if requestedSocket != socket {
			t.Errorf("socket=%q", requestedSocket)
		}
		startScriptedHerdrAt(t, socket, standardReply)
		return make(chan error), nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	availability, err := herdr.EnsureServer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !availability.Started || availability.Descriptor.Protocol != 19 || launches.Load() != 1 {
		t.Fatalf("availability=%+v launches=%d", availability, launches.Load())
	}
}

func TestEnsureHerdrServerDoesNotReplaceListeningInvalidAPI(t *testing.T) {
	socket := shortTestSocket(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.Remove(socket)
	})
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			_ = connection.Close()
		}
	}()

	herdr := NewHerdr(socket)
	herdr.launchServer = func(context.Context, string, string, string) (<-chan error, error) {
		t.Fatal("owned socket must not launch another server")
		return nil, nil
	}
	_, err = herdr.EnsureServer(context.Background())
	if err == nil || !strings.Contains(err.Error(), "listening but its API is not usable") {
		t.Fatalf("error=%v", err)
	}
}

func TestEnsureHerdrServerTimesOutWithoutClaimingSuccess(t *testing.T) {
	herdr := NewHerdr(shortTestSocket(t))
	herdr.TerminalBinary = "/opt/herdr/bin/herdr"
	herdr.bootstrapPoll = time.Millisecond
	herdr.launchServer = func(context.Context, string, string, string) (<-chan error, error) {
		return make(chan error), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()

	availability, err := herdr.EnsureServer(ctx)
	if err == nil || availability.Started || !strings.Contains(err.Error(), "did not become ready") {
		t.Fatalf("availability=%+v error=%v", availability, err)
	}
}

func TestSystemdHerdrArgsCreateIndependentSocketScopedUnit(t *testing.T) {
	t.Setenv("HERDR_CONFIG_PATH", "/home/test/.config/herdr/config.toml")
	t.Setenv("HERDR_SOCKET_PATH", "/run/user/1000/herdr.sock")
	args := systemdHerdrArgs("/home/test/.local/bin/herdr", "/home/test", "/run/user/1000/herdr.sock")
	joined := strings.Join(args, "\n")
	for _, expected := range []string{
		"--user", "--collect", "--property=Type=exec", "--property=Restart=no",
		"--working-directory=/home/test", "--setenv=HERDR_STARTUP_CWD=/home/test",
		"--setenv=HERDR_CONFIG_PATH=/home/test/.config/herdr/config.toml",
		"--setenv=HERDR_SOCKET_PATH=/run/user/1000/herdr.sock",
		"/home/test/.local/bin/herdr\nserver",
	} {
		if !strings.Contains(joined, expected) {
			t.Errorf("systemd args missing %q: %v", expected, args)
		}
	}
	other := strings.Join(systemdHerdrArgs("/home/test/.local/bin/herdr", "/home/test", "/run/user/1000/other.sock"), "\n")
	if args[3] == strings.Split(other, "\n")[3] {
		t.Fatal("different sockets reused the same transient unit")
	}
}

func TestLaunchDetachedHerdrServerUsesServerModeAndStartupDirectory(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "launch.log")
	t.Setenv("HERDR_BOOTSTRAP_TEST_LOG", logPath)
	t.Setenv("PAIRFOB_JOIN_GRANT", "must-not-leak")
	binary := filepath.Join(dir, "herdr")
	body := "#!/bin/sh\nset -eu\nprintf '%s\\n%s\\n%s\\n%s\\n' \"$*\" \"$PWD\" \"$HERDR_STARTUP_CWD\" \"${PAIRFOB_JOIN_GRANT-unset}\" > \"$HERDR_BOOTSTRAP_TEST_LOG\"\n"
	if err := os.WriteFile(binary, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}

	exited, err := launchDetachedHerdrServer(binary, dir)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("detached launcher was not reaped")
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) != 4 || lines[0] != "server" || lines[2] != dir || lines[3] != "unset" {
		t.Fatalf("launch log=%q", raw)
	}
	physicalDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	physicalPWD, err := filepath.EvalSymlinks(lines[1])
	if err != nil || physicalPWD != physicalDir {
		t.Fatalf("working directory=%q err=%v want=%q", lines[1], err, physicalDir)
	}
}

func TestRealHerdrBootstrapWhenRequested(t *testing.T) {
	if os.Getenv("PAIRFOB_TEST_REAL_HERDR_BOOTSTRAP") != "1" {
		t.Skip("set PAIRFOB_TEST_REAL_HERDR_BOOTSTRAP=1 for an isolated installed-Herdr smoke")
	}
	binary, err := exec.LookPath("herdr")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "pfhb-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	socket := filepath.Join(dir, "api.sock")
	t.Setenv("HERDR_CONFIG_PATH", filepath.Join(dir, "config.toml"))
	t.Setenv("HERDR_SOCKET_PATH", socket)
	t.Setenv("HERDR_CLIENT_SOCKET_PATH", filepath.Join(dir, "client.sock"))

	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "server", "stop")
		cmd.Env = herdrServerEnvironment(dir)
		_, _ = cmd.CombinedOutput()
	}
	t.Cleanup(stop)

	herdr := NewHerdr(socket)
	herdr.TerminalBinary = binary
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	availability, err := herdr.EnsureServer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !availability.Started || availability.Descriptor.Runtime != "herdr" || availability.Descriptor.Protocol <= 0 {
		t.Fatalf("availability=%+v", availability)
	}
}
