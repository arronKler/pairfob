package daemon

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"pairfob/internal/runtime"
	"pairfob/internal/workspace"
)

func TestWorkspaceMutationRPCDeduplicationAndValidation(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	_, client := runtimeRPCClient(t, fake)
	canonical, _ := filepath.EvalSymlinks(root)
	info, _ := os.Stat(filepath.Join(root, "src/app.ts"))
	p := map[string]any{"revision": workspace.FileRevision(info), "pane_id": "w0:p1", "root": canonical, "path": "src/app.ts", "new_name": "renamed.ts", "size": info.Size(), "modified_ms": info.ModTime().UnixMilli(), "operation_id": "op_file_rename_00000001"}
	raw, err := client.RPC("WorkspaceRename", p)
	if err != nil || !containsJSONText(raw, "applied") {
		t.Fatalf("rename=%s %v", raw, err)
	}
	// A replay succeeds without touching a subsequently recreated original name.
	if err := os.WriteFile(filepath.Join(root, "src/app.ts"), []byte("new original"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("WorkspaceRename", p); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "src/app.ts")); string(data) != "new original" {
		t.Fatal("replayed rename")
	}
	p["new_name"] = "different.ts"
	if _, err := client.RPC("WorkspaceRename", p); err == nil || err.Error() != "conflict" {
		t.Fatalf("operation reuse=%v", err)
	}
	delete(p, "new_name")
	p["path"] = "src/renamed.ts"
	p["operation_id"] = "op_file_delete_00000001"
	if _, err := client.RPC("WorkspaceDelete", p); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src/renamed.ts"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("WorkspaceDelete", p); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "src/renamed.ts")); string(data) != "replacement" {
		t.Fatal("replayed deletion")
	}
	p["operation_id"] = "op_file_delete_00000002"
	p["root"] = canonical + "/wrong"
	if _, err := client.RPC("WorkspaceDelete", p); err == nil {
		t.Fatal("accepted changed root")
	}
	p["root"] = canonical
	p["new_name"] = ""
	if _, err := client.RPC("WorkspaceDelete", p); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("delete accepted rename-only field: %v", err)
	}
	delete(p, "new_name")
	delete(p, "operation_id")
	if _, err := client.RPC("WorkspaceDelete", p); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("missing operation id=%v", err)
	}
}

type noFileMutationRuntime struct{ runtime.Runtime }

func (r noFileMutationRuntime) Describe(context.Context, runtime.SessionRef) (runtime.Descriptor, error) {
	return runtime.Descriptor{Runtime: "fake"}, nil
}

func TestWorkspaceMutationRequiresAdvertisedCapability(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	_, client := runtimeRPCClient(t, noFileMutationRuntime{fake})
	canonical, _ := filepath.EvalSymlinks(root)
	info, _ := os.Stat(filepath.Join(root, "src/app.ts"))
	p := map[string]any{"revision": workspace.FileRevision(info), "pane_id": "w0:p1", "root": canonical, "path": "src/app.ts", "size": info.Size(), "modified_ms": info.ModTime().UnixMilli(), "operation_id": "op_file_delete_disabled"}
	if _, err := client.RPC("WorkspaceDelete", p); err == nil || err.Error() != "unsupported" {
		t.Fatalf("unadvertised operation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "src/app.ts")); err != nil {
		t.Fatal("file changed without capability")
	}
}
