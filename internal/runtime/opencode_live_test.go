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

// The official CLI talks only to a loopback response fixture. Real Herdr,
// plugins, native persistence and the Pairfob reader remain in the path.
func TestOpenCodeNativeSessionsWhenRequested(t *testing.T) {
	binary := os.Getenv("PAIRFOB_OPENCODE_CLI")
	if binary == "" {
		t.Skip("set PAIRFOB_OPENCODE_CLI to an official OpenCode >=1.18.29 binary")
	}
	if info, err := os.Stat(binary); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("native acceptance executable unavailable: %s", binary)
	}
	herdr, err := exec.LookPath("herdr")
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("/tmp", "pf-oc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	for key, value := range map[string]string{"HOME": dir, "XDG_CONFIG_HOME": filepath.Join(dir, ".config"), "XDG_DATA_HOME": filepath.Join(dir, "data"), "XDG_CACHE_HOME": filepath.Join(dir, "cache"), "XDG_STATE_HOME": filepath.Join(dir, "state"), "HERDR_CONFIG_PATH": filepath.Join(dir, "config.toml"), "HERDR_SOCKET_PATH": filepath.Join(dir, "api.sock"), "HERDR_CLIENT_SOCKET_PATH": filepath.Join(dir, "client.sock"), "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1", "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1", "OPENCODE_DISABLE_LSP_DOWNLOAD": "1"} {
		t.Setenv(key, value)
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
		fmt.Fprint(w, `{"id":"fixture","object":"chat.completion","created":1,"model":"fixture","choices":[{"index":0,"message":{"role":"assistant","content":"Session observation verified"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	defer model.Close()
	configDir := filepath.Join(dir, ".config", "opencode")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf(`{"autoupdate":false,"share":"disabled","model":"fixture/fixture","small_model":"fixture/fixture","enabled_providers":["fixture"],"provider":{"fixture":{"npm":"@ai-sdk/openai-compatible","name":"Fixture","options":{"baseURL":%q,"apiKey":"test"},"models":{"fixture":{"name":"Fixture","limit":{"context":32768,"output":1024}}}}}}`, model.URL+"/v1")
	if err := os.WriteFile(filepath.Join(configDir, "opencode.json"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("HERDR_CONFIG_PATH"), []byte("[terminal]\ndefault_shell = \"/bin/bash\"\nshell_mode = \"non_login\"\n[update]\nmanifest_check = false\nversion_check = false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nif [ \"$1\" = --version ]; then exec " + shellQuoteHook(binary) + " --version; fi\nexec " + shellQuoteHook(binary) + " \"$@\" --prompt 'Inspect session titles'\n"
	if err := os.WriteFile(filepath.Join(bin, "opencode"), []byte(wrapper), 0700); err != nil {
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
	h := NewHerdr(os.Getenv("HERDR_SOCKET_PATH"))
	h.HookBinary = "/unused/pairfob"
	defer func() {
		if !t.Failed() {
			return
		}
		check, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		snapshot, _ := h.snapshot(check, SessionRef{})
		for _, pane := range snapshot.Panes {
			t.Logf("isolated binding: %+v", pane.AgentSession)
			raw, _ := h.call(check, SessionRef{}, "pane.read", map[string]any{"pane_id": pane.PaneID, "source": "visible", "lines": 35}, false)
			t.Logf("isolated native pane: %s", raw)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()
	for {
		if _, err := h.Describe(ctx, SessionRef{}); err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("Herdr startup")
		}
		time.Sleep(100 * time.Millisecond)
	}
	ids := map[string]bool{}
	for i := 0; i < 2; i++ {
		receipt, err := h.Execute(ctx, SessionRef{}, fmt.Sprintf("opencode-native-%d", i), CreateConversationCommand{CWD: dir, AgentKind: "opencode"})
		if err != nil {
			t.Fatalf("native OpenCode startup: %+v %v", receipt, err)
		}
		paneID := receiptEntityID(t, receipt, EntityPane)
		for {
			snapshot, err := h.snapshot(ctx, SessionRef{})
			if err != nil {
				t.Fatal(err)
			}
			ready := false
			for _, pane := range snapshot.Panes {
				if pane.PaneID != paneID || pane.AgentSession == nil {
					continue
				}
				ref := pane.AgentSession
				r := journal.NewDefault()
				title := r.ReadTitle(journal.Ref{Source: ref.Source, Agent: ref.Agent, Kind: ref.Kind, Value: ref.Value})
				if title.Prompt != "Inspect session titles" {
					continue
				}
				if ids[ref.Value] {
					t.Fatal("native sessions crossed panes")
				}
				ids[ref.Value] = true
				ready = true
			}
			if ready {
				break
			}
			if ctx.Err() != nil {
				t.Fatalf("OpenCode title unavailable: %+v", snapshot.Panes)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
}
