//go:build darwin || linux

package runtime

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This exercises real Herdr PTYs and process ancestry with a deterministic
// foreground fixture, without launching paid agents or touching live sessions.
func TestRealHerdrAgentBindingWhenRequested(t *testing.T) {
	hookBinary := os.Getenv("PAIRFOB_TEST_HOOK_BINARY")
	if hookBinary == "" {
		t.Skip("set PAIRFOB_TEST_HOOK_BINARY to a built Pairfob binary")
	}
	herdrBinary, err := exec.LookPath("herdr")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "pf-bind-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "api.sock")
	config := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(config, []byte("[terminal]\ndefault_shell = \"/bin/bash\"\nshell_mode = \"non_login\"\n[update]\nmanifest_check = false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, "state"))
	t.Setenv("HERDR_CONFIG_PATH", config)
	t.Setenv("HERDR_SOCKET_PATH", socket)
	t.Setenv("HERDR_CLIENT_SOCKET_PATH", filepath.Join(dir, "client.sock"))
	t.Setenv("PAIRFOB_ADMIN_SOCK", filepath.Join(dir, "admin.sock"))
	server := exec.Command(herdrBinary, "server")
	server.Dir = dir
	server.Env = herdrServerEnvironment(dir)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, herdrBinary, "server", "stop").Run()
		_ = server.Process.Kill()
		_ = server.Wait()
	}()
	h := NewHerdr(socket)
	fixture := filepath.Join(dir, "amp")
	cc := exec.Command("cc", "-x", "c", "-o", fixture, "-")
	cc.Stdin = strings.NewReader(`#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
static void report(char *binary, char *id, char *seq) {
  if (fork() == 0) { execl(binary, binary, "agent-hook", "amp", id, seq, "bind", NULL); _exit(1); }
  wait(NULL);
}
int main(int argc, char **argv) {
  puts("Amp\n> "); fflush(stdout); sleep(1);
  report(argv[1],argv[2],"100"); getchar();
  report(argv[1],argv[3],"200"); getchar(); return 0;
}`)
	if output, err := cc.CombinedOutput(); err != nil {
		t.Fatalf("build PTY fixture: %v: %s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	for {
		if _, err := h.Describe(ctx, SessionRef{}); err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("test Herdr did not start")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var panes []string
	for i := 0; i < 2; i++ {
		receipt, err := h.Execute(ctx, SessionRef{}, fmt.Sprintf("create-%d", i), CreateConversationCommand{CWD: dir, Label: "binding-test"})
		if err != nil {
			t.Fatal(err)
		}
		pane := receiptEntityID(t, receipt, EntityPane)
		panes = append(panes, pane)
		if err := h.waitCreatedShell(ctx, SessionRef{}, pane); err != nil {
			t.Fatal(err)
		}
		// The executable name exercises Herdr's native process detector. This
		// is a PTY contract fixture, not native Amp CLI acceptance.
		text := shellQuoteHook(fixture) + " " + shellQuoteHook(hookBinary) + " T-private-session-" + fmt.Sprint(i) + " T-switched-session-" + fmt.Sprint(i)
		if _, err := h.call(ctx, SessionRef{}, "pane.send_text", map[string]any{"pane_id": pane, "text": text}, true); err != nil {
			t.Fatal(err)
		}
		if _, err := h.call(ctx, SessionRef{}, "pane.send_keys", map[string]any{"pane_id": pane, "keys": []string{"enter"}}, true); err != nil {
			t.Fatal(err)
		}
	}
	await := func(wants []string) {
		t.Helper()
		var last Snapshot
		for {
			snapshot, err := h.snapshot(ctx, SessionRef{})
			if err != nil {
				t.Fatalf("snapshot failed: %v; last panes=%+v; binding root=%s", err, last.Panes, h.ConfigRoot)
			}
			last = snapshot
			matched := 0
			for i, id := range panes {
				for _, pane := range snapshot.Panes {
					if pane.PaneID == id && pane.AgentSession != nil && pane.AgentSession.Value == wants[i] {
						matched++
					}
				}
			}
			if matched == len(panes) {
				return
			}
			if ctx.Err() != nil {
				t.Fatalf("bindings did not arrive for %v; snapshot=%+v", panes, snapshot.Panes)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	await([]string{"T-private-session-0", "T-private-session-1"})
	// A reporter outside either foreground ancestry must not change its binding.
	if err := h.ReportAgentBinding(ctx, panes[0], AgentBindingReport{Agent: "amp", SessionID: "T-cross-pane-rejected", Sequence: 1000}); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("outside report: %v", err)
	}
	if _, err := h.call(ctx, SessionRef{}, "pane.send_keys", map[string]any{"pane_id": panes[0], "keys": []string{"enter"}}, true); err != nil {
		t.Fatal(err)
	}
	await([]string{"T-switched-session-0", "T-private-session-1"})
}
