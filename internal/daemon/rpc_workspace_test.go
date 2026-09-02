package daemon

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/runtime"
	"pairfob/internal/workspace"
)

func workspaceGit(t *testing.T, root string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
}

func workspaceRPCFixture(t *testing.T) (string, *runtime.Fake) {
	t.Helper()
	root := t.TempDir()
	workspaceGit(t, root, "init", "-b", "main")
	workspaceGit(t, root, "config", "user.email", "pairfob@example.invalid")
	workspaceGit(t, root, "config", "user.name", "Pairfob Test")
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "app.ts"), []byte("export const ready = false;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	workspaceGit(t, root, "add", ".")
	workspaceGit(t, root, "commit", "-m", "initial")
	if err := os.WriteFile(filepath.Join(root, "src", "app.ts"), []byte("export const ready = true;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	workspaceGit(t, root, "branch", "feature/mobile")
	fake := runtime.NewFake()
	fake.Snap.Workspaces[0].Cwd = root
	fake.Snap.Panes[0].Cwd = root
	return root, fake
}

func TestWorkspaceReadRPCUsesLivePaneRoot(t *testing.T) {
	_, fake := workspaceRPCFixture(t)
	_, client := runtimeRPCClient(t, fake)

	openedRaw, err := client.RPC("WorkspaceOpen", map[string]any{"pane_id": "w0:p1"})
	if err != nil {
		t.Fatal(err)
	}
	var opened struct {
		Name     string `json:"name"`
		Features struct {
			Files       bool `json:"files"`
			GitStatus   bool `json:"git_status"`
			GitDiff     bool `json:"git_diff"`
			GitBranches bool `json:"git_branches"`
		} `json:"features"`
	}
	if err := json.Unmarshal(openedRaw, &opened); err != nil || opened.Name == "" || !opened.Features.Files || !opened.Features.GitStatus || !opened.Features.GitDiff || !opened.Features.GitBranches {
		t.Fatalf("WorkspaceOpen=%s err=%v", openedRaw, err)
	}

	listRaw, err := client.RPC("WorkspaceList", map[string]any{"pane_id": "w0:p1", "path": "", "cursor": "", "limit": 20})
	if err != nil || !containsJSONText(listRaw, "src") {
		t.Fatalf("WorkspaceList=%s err=%v", listRaw, err)
	}
	readRaw, err := client.RPC("WorkspaceRead", map[string]any{"pane_id": "w0:p1", "path": "src/app.ts"})
	if err != nil || !containsJSONText(readRaw, "ready = true") {
		t.Fatalf("WorkspaceRead=%s err=%v", readRaw, err)
	}
	statusRaw, err := client.RPC("GitStatus", map[string]any{"pane_id": "w0:p1"})
	if err != nil || !containsJSONText(statusRaw, "src/app.ts") {
		t.Fatalf("GitStatus=%s err=%v", statusRaw, err)
	}
	diffRaw, err := client.RPC("GitDiff", map[string]any{"pane_id": "w0:p1", "path": "src/app.ts", "layer": "worktree"})
	if err != nil || !containsJSONText(diffRaw, "+export const ready = true") {
		t.Fatalf("GitDiff=%s err=%v", diffRaw, err)
	}
	branchesRaw, err := client.RPC("GitBranches", map[string]any{"pane_id": "w0:p1"})
	if err != nil || !containsJSONText(branchesRaw, "feature/mobile") {
		t.Fatalf("GitBranches=%s err=%v", branchesRaw, err)
	}
}

func TestWorkspaceReadRPCFailsClosed(t *testing.T) {
	_, fake := workspaceRPCFixture(t)
	_, client := runtimeRPCClient(t, fake)
	if _, err := client.RPC("WorkspaceRead", map[string]any{"pane_id": "w0:p1", "path": "../outside"}); err == nil || err.Error() != "forbidden" {
		t.Fatalf("traversal error=%v", err)
	}
	if _, err := client.RPC("WorkspaceOpen", map[string]any{"pane_id": "missing"}); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("missing pane error=%v", err)
	}
	if _, err := client.RPC("WorkspaceList", map[string]any{"pane_id": "w0:p1", "path": "", "surprise": true}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("unknown field error=%v", err)
	}
}

func TestWorkspaceReadRPCBoundsEscapedContent(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "many-lines.txt"), []byte(strings.Repeat("\t", workspace.MaxPreviewBytes)), 0o644); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)
	raw, err := client.RPC("WorkspaceRead", map[string]any{"pane_id": "w0:p1", "path": "many-lines.txt"})
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, raw)
	if len(raw) >= 240*1024 || result["truncated"] != true {
		t.Fatalf("WorkspaceRead bytes=%d err=%v", len(raw), err)
	}
}
