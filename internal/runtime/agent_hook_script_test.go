package runtime

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAmpObservationPlugin(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun required for the Amp plugin event harness")
	}
	if data, err := exec.Command(bun, "test", "agent-hooks/amp.test.ts").CombinedOutput(); err != nil {
		t.Fatalf("Amp event harness: %v\n%s", err, data)
	}
}

func TestMakiObservationPluginWhenRequested(t *testing.T) {
	luau := os.Getenv("PAIRFOB_LUAU_BIN")
	if luau == "" {
		t.Skip("set PAIRFOB_LUAU_BIN for the Maki event harness")
	}
	harness, err := os.ReadFile("agent-hooks/maki.test.lua")
	if err != nil {
		t.Fatal(err)
	}
	source, _ := agentHookFiles.ReadFile("agent-hooks/maki.lua")
	plugin := strings.ReplaceAll(string(source), "PAIRFOB_BINARY", `"/safe/pairfob"`)
	// A function scope matches require(): the plugin's early return does not
	// skip harness assertions or violate Lua's return-must-be-last rule.
	content := strings.Replace(string(harness), "-- INSERT_MANAGED_MAKI_PLUGIN", "local function loadPlugin()\n"+plugin+"\nend\nloadPlugin()", 1)
	path := filepath.Join(t.TempDir(), "maki-test.lua")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(luau, path).CombinedOutput(); err != nil {
		t.Fatalf("Maki event harness: %v\n%s", err, output)
	}
}

func TestCommandCodeObservationPlugin(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun required")
	}
	if data, err := exec.Command(bun, "test", "agent-hooks/command-code.test.ts").CombinedOutput(); err != nil {
		t.Fatalf("Command Code event harness: %v\n%s", err, data)
	}
}
