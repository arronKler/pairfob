package daemon

import (
	"os"
	"path/filepath"
	"testing"

	"pairfob/internal/phone"
	"pairfob/internal/runtime"
)

func TestWorkspaceMediaRPCFailsClosedOnTraversalAndSymlink(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	outside := filepath.Join(t.TempDir(), "secret.bin")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)
	if _, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "../secret.bin"}); err == nil || err.Error() != "forbidden" {
		t.Fatalf("traversal err=%v", err)
	}
	if _, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "escape"}); err == nil || err.Error() != "forbidden" {
		t.Fatalf("symlink err=%v", err)
	}
	if _, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "missing", "path": "src/app.ts"}); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("missing pane err=%v", err)
	}
}

func TestWorkspaceMediaRPCDetectsRewriteAndCwdChange(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	path := filepath.Join(root, "clip.bin")
	if err := os.WriteFile(path, []byte("version-one"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)
	handle := openMedia(t, client, "clip.bin")["handle"].(string)
	if err := os.WriteFile(path, []byte("version-two!"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": 4}); err == nil || err.Error() != "conflict" {
		t.Fatalf("rewrite err=%v", err)
	}

	mediaPNG(t, root, "cat.png", tinyPNG())
	handle = openMedia(t, client, "cat.png")["handle"].(string)
	other := t.TempDir()
	fake.Snap.Panes[0].Cwd = other
	fake.Snap.Workspaces[0].Cwd = other
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": 4}); err == nil || (err.Error() != "conflict" && err.Error() != "workspace_not_found" && err.Error() != "forbidden") {
		t.Fatalf("cwd change err=%v", err)
	}
}

func TestWorkspaceMediaRPCRejectsCrossSessionAndMissingPane(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "cat.png", tinyPNG())
	engine, client := runtimeRPCClient(t, fake)
	handle := openMedia(t, client, "cat.png")["handle"].(string)
	other := attachPhone(t, engine)
	if _, err := other.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": 4}); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("cross-session err=%v", err)
	}

	fake.Snap.Panes = []runtime.Pane{}
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": 4}); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("missing pane err=%v", err)
	}
}

func TestWorkspaceMediaRPCRejectsOversizeDownload(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "huge.bin"), make([]byte, 32<<20+1), 0o644); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)
	if _, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "huge.bin"}); err == nil || err.Error() != "too_large" {
		t.Fatalf("oversize err=%v", err)
	}
}

func TestWorkspaceMediaRPCCloseReleasesSessionQuota(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "a.bin", []byte("a"))
	mediaPNG(t, root, "b.bin", []byte("b"))
	_, client := runtimeRPCClient(t, fake)
	handle := openMedia(t, client, "a.bin")["handle"].(string)
	if _, err := client.RPC("WorkspaceMediaClose", map[string]any{"handle": handle}); err != nil {
		t.Fatal(err)
	}
	if openMedia(t, client, "b.bin")["handle"] == "" {
		t.Fatal("expected reopen after close")
	}
}

func TestWorkspaceMediaRPCDisconnectReleasesHandle(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "cat.png", tinyPNG())
	engine, client := runtimeRPCClient(t, fake)
	handle := openMedia(t, client, "cat.png")["handle"].(string)
	engine.closeSession(clientRoute(engine, client), "", false)
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": 1}); err == nil {
		t.Fatal("expected closed session to stop media reads")
	}
}

func clientRoute(engine *Engine, client *phone.Client) [16]byte {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	for rid, s := range engine.sessions {
		if s.deviceID == client.DeviceID {
			return rid
		}
	}
	return [16]byte{}
}
