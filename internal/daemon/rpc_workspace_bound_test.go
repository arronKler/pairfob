package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"pairfob/internal/workspace"
)

func TestWorkspaceBoundReadsRejectMovedRoot(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	canonical, err := workspace.CanonicalRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)
	if _, err := client.RPC("WorkspaceResolve", map[string]any{"pane_id": "w0:p1", "root": canonical, "path": root + "/src/app.ts"}); err != nil {
		t.Fatal(err)
	}
	var handle string
	for _, op := range []string{"WorkspaceListAtRoot", "WorkspaceReadAtRoot", "WorkspaceMediaOpenAtRoot"} {
		path := "src/app.ts"
		if op == "WorkspaceListAtRoot" {
			path = "src"
		}
		raw, err := client.RPC(op, map[string]any{"pane_id": "w0:p1", "root": canonical, "path": path})
		if err != nil {
			t.Fatalf("%s: %v", op, err)
		}
		if op == "WorkspaceMediaOpenAtRoot" {
			var result struct {
				Handle string `json:"handle"`
			}
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			handle = result.Handle
		}
		for _, bad := range []map[string]any{
			{"pane_id": "w0:p1", "path": path},
			{"pane_id": "w0:p1", "root": canonical, "path": path, "extra": true},
			{"pane_id": "w0:p1", "root": canonical, "path": "../secret"},
		} {
			if _, err := client.RPC(op, bad); err == nil {
				t.Fatalf("%s accepted %+v", op, bad)
			}
		}
	}
	// The new cwd contains a same-name file: a relative fallback would return it.
	other := t.TempDir()
	if err := os.MkdirAll(filepath.Join(other, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "src/app.ts"), []byte("wrong workspace"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake.Snap.Panes[0].Cwd = other
	fake.Snap.Workspaces[0].Cwd = other
	for _, op := range []string{"WorkspaceListAtRoot", "WorkspaceReadAtRoot", "WorkspaceMediaOpenAtRoot"} {
		path := "src/app.ts"
		if op == "WorkspaceListAtRoot" {
			path = "src"
		}
		if raw, err := client.RPC(op, map[string]any{"pane_id": "w0:p1", "root": canonical, "path": path}); err == nil || err.Error() != "conflict" {
			t.Fatalf("%s after cwd change: %s %v", op, raw, err)
		}
	}
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": 1}); err == nil {
		t.Fatal("old media handle survived cwd change")
	}
}
