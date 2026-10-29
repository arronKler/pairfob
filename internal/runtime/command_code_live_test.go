//go:build darwin || linux

package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/journal"
)

// Run against an explicitly supplied official CLI in an isolated HOME/Herdr.
// Inference uses a loopback response fixture; no account or paid provider is used.
func TestCommandCodeNativeSessionWhenRequested(t *testing.T) {
	cli, hook := os.Getenv("PAIRFOB_COMMAND_CODE_CLI"), os.Getenv("PAIRFOB_TEST_HOOK_BINARY")
	if cli == "" || hook == "" {
		t.Skip("set PAIRFOB_COMMAND_CODE_CLI and PAIRFOB_TEST_HOOK_BINARY")
	}
	for _, path := range []string{cli, hook} {
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("native acceptance executable unavailable: %s", path)
		}
	}
	herdr, err := exec.LookPath("herdr")
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "pf-cmd-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "api.sock")
	config := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(config, []byte("[terminal]\ndefault_shell = \"/bin/bash\"\nshell_mode = \"non_login\"\n[update]\nmanifest_check = false\nversion_check = false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{"HOME": dir, "XDG_CONFIG_HOME": filepath.Join(dir, "config"), "XDG_STATE_HOME": filepath.Join(dir, "state"), "HERDR_CONFIG_PATH": config, "HERDR_SOCKET_PATH": socket, "HERDR_CLIENT_SOCKET_PATH": filepath.Join(dir, "client.sock"), "CMD_HERDR_PANE_OWNER": "", "COMMAND_CODE_API_KEY": "user_pairfob-offline-fixture", "DO_NOT_TRACK": "1", "CMD_LOCAL_ONLY": "1"} {
		t.Setenv(key, value)
	}
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Stream bool `json:"stream"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		if input.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Session observation verified\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "fixture-response", "object": "chat.completion", "created": 1, "model": "fixture", "choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "Session observation verified"}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
	}))
	defer model.Close()
	if err := os.MkdirAll(filepath.Join(dir, ".commandcode"), 0700); err != nil {
		t.Fatal(err)
	}
	providers := fmt.Sprintf(`{"provider":{"fixture":{"baseURL":%q,"apiKey":false,"models":{"fixture":{}}}}}`, model.URL+"/v1")
	if err := os.WriteFile(filepath.Join(dir, ".commandcode", "providers.json"), []byte(providers), 0600); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nexec " + shellQuoteHook(node) + " " + shellQuoteHook(cli) + " --local-only --model fixture/fixture --trust --skip-onboarding 'Inspect session titles'\n"
	if err := os.WriteFile(filepath.Join(bin, "command-code"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	server := exec.Command(herdr, "server")
	server.Dir = dir
	server.Env = herdrServerEnvironment(dir)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = exec.CommandContext(ctx, herdr, "server", "stop").Run()
		_ = server.Process.Kill()
		_ = server.Wait()
	}()
	h := NewHerdr(socket)
	h.HookBinary = hook
	defer func() {
		if !t.Failed() {
			return
		}
		check, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		snapshot, _ := h.snapshot(check, SessionRef{})
		t.Logf("native failure snapshot: %+v", snapshot.Panes)
		for _, pane := range snapshot.Panes {
			raw, _ := h.call(check, SessionRef{}, "pane.read", map[string]any{"pane_id": pane.PaneID, "source": "visible", "lines": 35}, false)
			t.Logf("isolated native pane: %s", raw)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 360*time.Second)
	defer cancel()
	for {
		if _, err := h.Describe(ctx, SessionRef{}); err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("Herdr startup")
		}
		time.Sleep(50 * time.Millisecond)
	}
	ids := map[string]bool{}
	for i := 0; i < 2; i++ {
		project := filepath.Join(dir, fmt.Sprintf("project-%d", i))
		if err := os.MkdirAll(project, 0700); err != nil {
			t.Fatal(err)
		}
		receipt, err := h.Execute(ctx, SessionRef{}, fmt.Sprintf("native-%d", i), CreateConversationCommand{CWD: project, AgentKind: "cmd", Label: "Native CLI acceptance"})
		if err != nil {
			snapshot, _ := h.snapshot(context.Background(), SessionRef{})
			t.Logf("snapshot: %+v", snapshot.Panes)
			files, _ := filepath.Glob(filepath.Join(h.ConfigRoot, "pairfob-agent-bindings", "*.json"))
			for _, f := range files {
				b, _ := os.ReadFile(f)
				t.Logf("local binding: %s", b)
			}
			for _, pane := range snapshot.Panes {
				raw, _ := h.call(context.Background(), SessionRef{}, "pane.read", map[string]any{"pane_id": pane.PaneID, "source": "visible", "lines": 30}, false)
				t.Logf("isolated test pane: %s", raw)
			}
			t.Fatalf("start: %+v %v", receipt, err)
		}
		paneID := receiptEntityID(t, receipt, EntityPane)
		var snapshot Snapshot
		for {
			snapshot, err = h.snapshot(ctx, SessionRef{})
			if err != nil {
				t.Fatalf("binding wait: %v; last snapshot: %+v", err, snapshot.Panes)
			}
			ready := false
			for _, pane := range snapshot.Panes {
				if pane.PaneID == paneID && pane.AgentSession != nil {
					ref := pane.AgentSession
					title := journal.NewDefault().ReadTitle(journal.Ref{Source: ref.Source, Agent: ref.Agent, Kind: ref.Kind, Value: ref.Value, Leaf: ref.Leaf})
					ready = title.Prompt == "Inspect session titles"
				}
			}
			if ready {
				break
			}
			if ctx.Err() != nil {
				t.Fatalf("native binding missing: %+v", snapshot.Panes)
			}
			time.Sleep(100 * time.Millisecond)
		}
		matched := false
		for _, pane := range snapshot.Panes {
			if pane.PaneID != paneID {
				continue
			}
			ref := pane.AgentSession
			if ref == nil || ids[ref.Value] || ref.Leaf == nil {
				t.Fatalf("binding: %+v", ref)
			}
			r := journal.NewDefault()
			title := r.ReadTitle(journal.Ref{Source: ref.Source, Agent: ref.Agent, Kind: ref.Kind, Value: ref.Value, Leaf: ref.Leaf})
			if title.Prompt != "Inspect session titles" {
				t.Fatalf("title: %+v", title)
			}
			ids[ref.Value] = true
			matched = true
		}
		if !matched {
			t.Fatal("pane missing")
		}
	}
}
