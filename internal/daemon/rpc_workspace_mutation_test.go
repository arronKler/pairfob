package daemon

import (
	"context"
	"errors"
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

// selectedSessionMutationRuntime models a stopped default Herdr server beside a
// live named session: only the selected session may answer Describe.
type selectedSessionMutationRuntime struct {
	runtime.Runtime
	live string
}

func (r *selectedSessionMutationRuntime) Describe(ctx context.Context, session runtime.SessionRef) (runtime.Descriptor, error) {
	if session.Name != r.live {
		return runtime.Descriptor{}, &runtime.Fault{Code: runtime.CodeOffline, Outcome: runtime.OutcomeNotApplied, SafeMessage: "offline"}
	}
	descriptor, err := r.Runtime.Describe(ctx, session)
	descriptor.Runtime = "herdr"
	return descriptor, err
}

// A mutation must describe the same session its workspace root and ledger
// fingerprint use. Describing the default session made GetConfig advertise a
// capability for the live named session while the mutation itself failed
// herdr_offline and never ran.
func TestWorkspaceMutationUsesSelectedSession(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	_, client := runtimeRPCClient(t, &selectedSessionMutationRuntime{Runtime: fake, live: "work"})
	canonical, _ := filepath.EvalSymlinks(root)

	namedRaw, err := client.RPC("GetConfig", map[string]any{"session": "work"})
	if err != nil {
		t.Fatal(err)
	}
	named := decodeResult(t, namedRaw)["capabilities"].(map[string]any)
	if named["rename_file"] != true || named["delete_file"] != true {
		t.Fatalf("named session capabilities: %s", namedRaw)
	}
	defaultRaw, err := client.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	stopped := decodeResult(t, defaultRaw)["capabilities"].(map[string]any)
	if stopped["rename_file"] != false || stopped["delete_file"] != false {
		t.Fatalf("stopped default session capabilities: %s", defaultRaw)
	}

	info, err := os.Stat(filepath.Join(root, "src/app.ts"))
	if err != nil {
		t.Fatal(err)
	}
	defaultDelete := map[string]any{"revision": workspace.FileRevision(info), "pane_id": "w0:p1", "root": canonical, "path": "src/app.ts", "size": info.Size(), "modified_ms": info.ModTime().UnixMilli(), "operation_id": "op_file_delete_default01"}
	if raw, err := client.RPC("WorkspaceDelete", defaultDelete); err == nil || err.Error() != "herdr_offline" {
		t.Fatalf("default session delete=%s err=%v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(root, "src/app.ts")); err != nil {
		t.Fatal("default session changed the file")
	}

	rename := map[string]any{"session": "work", "revision": workspace.FileRevision(info), "pane_id": "w0:p1", "root": canonical, "path": "src/app.ts", "new_name": "renamed.ts", "size": info.Size(), "modified_ms": info.ModTime().UnixMilli(), "operation_id": "op_file_rename_selected1"}
	if raw, err := client.RPC("WorkspaceRename", rename); err != nil || !containsJSONText(raw, "applied") {
		t.Fatalf("selected session rename=%s err=%v", raw, err)
	}
	renamed := filepath.Join(root, "src/renamed.ts")
	renamedInfo, err := os.Stat(renamed)
	if err != nil {
		t.Fatal(err)
	}
	deleteParams := map[string]any{"session": "work", "revision": workspace.FileRevision(renamedInfo), "pane_id": "w0:p1", "root": canonical, "path": "src/renamed.ts", "size": renamedInfo.Size(), "modified_ms": renamedInfo.ModTime().UnixMilli(), "operation_id": "op_file_delete_selected1"}
	if raw, err := client.RPC("WorkspaceDelete", deleteParams); err != nil || !containsJSONText(raw, "applied") {
		t.Fatalf("selected session delete=%s err=%v", raw, err)
	}
	if _, err := os.Stat(renamed); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("selected session delete left the file: %v", err)
	}
}
