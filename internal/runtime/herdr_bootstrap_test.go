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
		t.Skip("set PAIRFOB_TEST_REAL_HERDR_BOOTSTRAP=1 for the isolated installed-Herdr contract smoke")
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
	configPath := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(configPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "xdg-config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, "xdg-state"))
	t.Setenv("HERDR_CONFIG_PATH", configPath)
	t.Setenv("HERDR_SOCKET_PATH", socket)
	t.Setenv("HERDR_CLIENT_SOCKET_PATH", filepath.Join(dir, "client.sock"))

	var serverLaunched atomic.Bool
	stop := func() {
		if !serverLaunched.Load() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "server", "stop")
		cmd.Dir = dir
		cmd.Env = herdrServerEnvironment(dir)
		if output, stopErr := cmd.CombinedOutput(); stopErr != nil {
			t.Errorf("isolated Herdr server stop failed: %v: %s", stopErr, strings.TrimSpace(string(output)))
		}
	}
	t.Cleanup(stop)

	herdr := NewHerdr(socket)
	herdr.TerminalBinary = binary
	herdr.launchServer = func(ctx context.Context, binary, _ string, socket string) (<-chan error, error) {
		exited, launchErr := launchPersistentHerdrServer(ctx, binary, dir, socket)
		if launchErr == nil {
			serverLaunched.Store(true)
		}
		return exited, launchErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	availability, err := herdr.EnsureServer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !availability.Started || availability.Descriptor.Runtime != "herdr" || availability.Descriptor.Protocol <= 0 {
		t.Fatalf("availability=%+v", availability)
	}
	for _, feature := range []Feature{FeatureCreateConversation, FeatureCreateTab, FeatureSplitPane} {
		if !availability.Descriptor.Supports(feature) {
			t.Fatalf("installed Herdr protocol %d does not support %s", availability.Descriptor.Protocol, feature)
		}
	}

	conversation, err := herdr.Execute(ctx, DefaultSession(), "contract-create-conversation", CreateConversationCommand{
		CWD: dir, Label: "pairfob-contract",
	})
	if err != nil || conversation.Outcome != OutcomeApplied {
		t.Fatalf("CreateConversation receipt=%+v err=%v", conversation, err)
	}
	workspaceID := receiptEntityID(t, conversation, EntityWorkspace)
	rootPaneID := receiptEntityID(t, conversation, EntityPane)
	rejectReceiptEntity(t, conversation, EntityAgent)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = herdr.Execute(cleanupCtx, DefaultSession(), "contract-cleanup-workspace", CloseWorkspaceCommand{WorkspaceID: workspaceID})
	})

	tab, err := herdr.Execute(ctx, DefaultSession(), "contract-create-tab", CreateTabCommand{
		WorkspaceID: workspaceID, CWD: dir, Label: "contract-tab",
	})
	if err != nil || tab.Outcome != OutcomeApplied {
		t.Fatalf("CreateTab receipt=%+v err=%v", tab, err)
	}
	receiptEntityID(t, tab, EntityTab)
	receiptEntityID(t, tab, EntityPane)
	rejectReceiptEntity(t, tab, EntityAgent)

	split, err := herdr.Execute(ctx, DefaultSession(), "contract-split-pane", SplitPaneCommand{
		WorkspaceID: workspaceID, TargetPaneID: rootPaneID, CWD: dir, Direction: SplitRight,
	})
	if err != nil || split.Outcome != OutcomeApplied {
		t.Fatalf("SplitPane receipt=%+v err=%v", split, err)
	}
	receiptEntityID(t, split, EntityPane)
	rejectReceiptEntity(t, split, EntityAgent)

	if kind := strings.TrimSpace(os.Getenv("PAIRFOB_TEST_REAL_HERDR_AGENT_KIND")); kind != "" {
		if !containsAgent(availability.Descriptor.AgentKinds, kind) {
			t.Fatalf("PAIRFOB_TEST_REAL_HERDR_AGENT_KIND=%q is not installed", kind)
		}
		agentCtx, agentCancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer agentCancel()
		agentConversation, agentErr := herdr.Execute(agentCtx, DefaultSession(), "contract-create-agent", CreateConversationCommand{
			CWD: dir, Label: "pairfob-agent-contract", AgentKind: kind, AgentName: "pf-contract",
		})
		if agentErr != nil || agentConversation.Outcome != OutcomeApplied {
			t.Fatalf("CreateConversation agent receipt=%+v err=%v", agentConversation, agentErr)
		}
		agentWorkspaceID := receiptEntityID(t, agentConversation, EntityWorkspace)
		receiptEntityID(t, agentConversation, EntityAgent)
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cleanupCancel()
			_, _ = herdr.Execute(cleanupCtx, DefaultSession(), "contract-cleanup-agent-workspace", CloseWorkspaceCommand{WorkspaceID: agentWorkspaceID})
		})
	}
}

func receiptEntityID(t *testing.T, receipt Receipt, kind EntityKind) string {
	t.Helper()
	for _, entity := range receipt.Created {
		if entity.Kind == kind && entity.ID != "" {
			return entity.ID
		}
	}
	t.Fatalf("receipt %+v has no created %s", receipt, kind)
	return ""
}

func rejectReceiptEntity(t *testing.T, receipt Receipt, kind EntityKind) {
	t.Helper()
	for _, entity := range receipt.Created {
		if entity.Kind == kind {
			t.Fatalf("receipt %+v unexpectedly created %s", receipt, kind)
		}
	}
}
