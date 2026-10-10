package daemon

import (
	"encoding/json"
	"testing"

	"pairfob/internal/workspace"
)

func TestWorkspaceResolveRPC(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	canonical, err := workspace.CanonicalRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	_, client := runtimeRPCClient(t, fake)
	for _, tc := range []struct{ input, path, kind string }{{"~/src/app.ts", "src/app.ts", "file"}, {root + "/src", "src", "directory"}, {root, "", "directory"}} {
		raw, err := client.RPC("WorkspaceResolve", map[string]any{"pane_id": "w0:p1", "root": canonical, "path": tc.input})
		if err != nil {
			t.Fatal(err)
		}
		var result workspace.Reference
		if err := json.Unmarshal(raw, &result); err != nil || result.Root != canonical || result.Path != tc.path || result.Kind != tc.kind {
			t.Fatalf("%s: %v", raw, err)
		}
	}
	for _, params := range []map[string]any{
		{"pane_id": "w0:p1", "root": canonical, "path": "/tmp/outside.html"},
		{"pane_id": "w0:p1", "root": "/stale", "path": "~/src/app.ts"},
		{"pane_id": "missing", "root": canonical, "path": "~/src/app.ts"},
		{"pane_id": "w0:p1", "path": "~/src/app.ts"},
		{"pane_id": "w0:p1", "root": canonical, "path": "~/src/app.ts", "extra": true},
	} {
		if _, err := client.RPC("WorkspaceResolve", params); err == nil {
			t.Fatalf("accepted %+v", params)
		}
	}
}
