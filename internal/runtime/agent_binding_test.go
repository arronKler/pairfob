//go:build darwin || linux

package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLocalAgentBindingLifecycle(t *testing.T) {
	for _, agent := range []string{"gemini", "cline", "amp", "maki", "cmd"} {
		t.Run(agent, func(t *testing.T) {
			var mu sync.Mutex
			pid, terminal, detected := os.Getpid(), "terminal_one", agent
			socket, _ := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply {
				mu.Lock()
				defer mu.Unlock()
				switch req.Method {
				case "pane.current":
					return scriptedReply{Result: map[string]any{"type": "pane_current", "pane": map[string]any{"pane_id": "w1:p1"}}}
				case "pane.process_info":
					return scriptedReply{Result: map[string]any{"type": "pane_process_info", "process_info": map[string]any{"pane_id": "w1:p1", "shell_pid": 1, "foreground_process_group_id": pid, "foreground_processes": []any{map[string]any{"pid": pid, "name": agent}}}}}
				case "session.snapshot":
					return scriptedReply{Result: map[string]any{"type": "session_snapshot", "snapshot": map[string]any{"version": "0.9.3", "protocol": 22, "workspaces": []any{}, "tabs": []any{}, "panes": []any{map[string]any{"pane_id": "w1:p1", "terminal_id": terminal, "workspace_id": "w1", "tab_id": "w1:t1", "agent": detected, "agent_status": "idle"}}}}}
				}
				return standardReply(req)
			})
			h := NewHerdr(socket)
			h.ConfigRoot = t.TempDir()
			ctx := context.Background()
			report := func(id string, seq int64, clear bool) {
				t.Helper()
				if err := h.ReportAgentBinding(ctx, "w1:p1", AgentBindingReport{Agent: agent, SessionID: id, Sequence: seq, Clear: clear, Leaf: new(string)}); err != nil {
					t.Fatal(err)
				}
			}
			assertBinding := func(want string) string {
				t.Helper()
				snapshot, err := h.snapshot(ctx, SessionRef{})
				if err != nil {
					t.Fatal(err)
				}
				pane := snapshot.Panes[0]
				if want == "" {
					if pane.AgentSession != nil || pane.HistoryAvailable {
						t.Fatalf("unexpected binding: %+v", pane)
					}
				} else if pane.AgentSession == nil || pane.AgentSession.Value != want || pane.AgentSession.Source != "pairfob:"+agent || !pane.HistoryAvailable {
					t.Fatalf("missing %s: %+v", want, pane)
				}
				data, _ := json.Marshal(snapshot)
				if strings.Contains(string(data), "private-session") || strings.Contains(string(data), "pairfob:") || strings.Contains(string(data), "process_id") {
					t.Fatalf("private binding leaked: %s", data)
				}
				return pane.AgentInstanceID
			}
			assertBinding("")
			if err := h.ReportAgentBinding(ctx, "old-pane-alias", AgentBindingReport{Agent: agent, SessionID: "private-session-A", Sequence: 100, Leaf: new(string)}); err != nil {
				t.Fatal(err)
			}
			first := assertBinding("private-session-A")
			// Reconstruct the adapter to simulate a daemon restart.
			restarted := NewHerdr(socket)
			restarted.ConfigRoot = h.ConfigRoot
			h = restarted
			assertBinding("private-session-A")
			report("private-session-B", 200, false)
			if first == assertBinding("private-session-B") {
				t.Fatal("session switch retained old instance identity")
			}
			report("private-session-A", 150, false)
			report("private-session-A", 300, true)
			assertBinding("private-session-B")
			report("private-session-B", 400, true)
			assertBinding("")
			report("private-session-B", 350, false)
			assertBinding("")
			report("private-session-C", 500, false)
			mu.Lock()
			terminal = "terminal_replacement"
			mu.Unlock()
			assertBinding("")
			mu.Lock()
			terminal = "terminal_one"
			pid = 2
			mu.Unlock()
			assertBinding("")
			mu.Lock()
			pid = os.Getpid()
			detected = "codex"
			mu.Unlock()
			assertBinding("")
			if err := h.ReportAgentBinding(ctx, "w1:p1", AgentBindingReport{Agent: agent, SessionID: "private-session-X", Sequence: 600}); err == nil {
				t.Fatal("bound a different detected agent")
			}
			mu.Lock()
			detected = agent
			mu.Unlock()
			path, _ := h.bindingPath(SessionRef{}, "terminal_one")
			old, _ := readLocalAgentBinding(path)
			old.Birth = "reused PID"
			old.Sequence = 1000
			if err := saveLocalAgentBinding(path, old); err != nil {
				t.Fatal(err)
			}
			assertBinding("")
			other := NewHerdr(filepath.Join(t.TempDir(), "other.sock"))
			other.ConfigRoot = h.ConfigRoot
			otherPath, _ := other.bindingPath(SessionRef{}, "terminal_one")
			if path == otherPath {
				t.Fatal("binding crosses Herdr servers")
			}
		})
	}
}

func TestLocalAgentBindingRejectsUnsafeStorage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bindings", "record.json")
	record := localAgentBinding{Version: 1, Agent: "amp", SessionID: "private-session", ProcessID: os.Getpid(), Birth: "birth", Sequence: 1}
	if err := saveLocalAgentBinding(path, record); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readLocalAgentBinding(path); err == nil {
		t.Fatal("read public binding file")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "outside"), path); err != nil {
		t.Fatal(err)
	}
	if err := saveLocalAgentBinding(path, record); err == nil {
		t.Fatal("replaced symlink")
	}
	if !localHookDescendsFrom(context.Background(), os.Getpid(), "amp") || localHookDescendsFrom(context.Background(), 2147483647, "amp") {
		t.Fatal("hook ancestry verification")
	}
}

func TestLocalAgentBindingTimestampCollision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bindings", "record.json")
	record := localAgentBinding{Version: 1, Agent: "gemini", SessionID: "session-one", ProcessID: 10, Birth: "same-process", Sequence: 100}
	if err := saveLocalAgentBinding(path, record); err != nil {
		t.Fatal(err)
	}
	record.SessionID = "session-two"
	if err := saveLocalAgentBinding(path, record); err != nil {
		t.Fatal(err)
	}
	got, err := readLocalAgentBinding(path)
	if err != nil || !got.Cleared {
		t.Fatalf("ambiguous timestamp exposed one session: %+v %v", got, err)
	}
	if err := saveLocalAgentBinding(path, record); err != nil {
		t.Fatal(err)
	}
	got, _ = readLocalAgentBinding(path)
	if !got.Cleared {
		t.Fatal("same timestamp resurrected an ambiguous binding")
	}
	record.Sequence++
	if err := saveLocalAgentBinding(path, record); err != nil {
		t.Fatal(err)
	}
	got, _ = readLocalAgentBinding(path)
	if got.Cleared || got.SessionID != "session-two" {
		t.Fatalf("new report not accepted: %+v", got)
	}
	oldExit := record
	oldExit.SessionID = "session-one"
	oldExit.Cleared = true
	if err := saveLocalAgentBinding(path, oldExit); err != nil {
		t.Fatal(err)
	}
	got, _ = readLocalAgentBinding(path)
	if got.Cleared {
		t.Fatal("old exit cleared new binding")
	}
}
