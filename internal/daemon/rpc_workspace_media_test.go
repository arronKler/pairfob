package daemon

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/phone"
	"pairfob/internal/workspace"
)

func mediaPNG(t *testing.T, root, name string, payload []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, name), payload, 0o644); err != nil {
		t.Fatal(err)
	}
}

func tinyPNG() []byte {
	return []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
		0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
		0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	}
}

func attachPhone(t *testing.T, engine *Engine) *phone.Client {
	t.Helper()
	psk := make([]byte, 32)
	if _, err := rand.Read(psk); err != nil {
		t.Fatal(err)
	}
	deviceID := "dev_" + hex.EncodeToString(psk[:8])
	engine.PutDevice(deviceID, psk)
	clientSide, hubClient := mux.NewPipePair(128)
	stopClient := pump(t, hubClient, func(frame envelope.Frame) { engine.Hub.HandleClient(hubClient, frame) })
	t.Cleanup(func() { close(stopClient) })
	client := &phone.Client{Conn: clientSide, DeviceID: deviceID, PSK: psk, DaemonPK: engine.PK}
	if err := client.Resume(engine.DaemonID); err != nil {
		t.Fatal(err)
	}
	return client
}

func openMedia(t *testing.T, client *phone.Client, path string) map[string]any {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": path}, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return decodeResult(t, raw)
}

func TestWorkspaceMediaRPCReadsAuthorizedChunks(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	payload := tinyPNG()
	mediaPNG(t, root, "cat.png", payload)
	_, client := runtimeRPCClient(t, fake)

	opened := openMedia(t, client, "cat.png")
	if opened["kind"] != "image" || opened["mime"] != "image/png" || opened["chunk_bytes"] != float64(workspace.MediaChunkBytes) {
		t.Fatalf("open=%v", opened)
	}
	handle, _ := opened["handle"].(string)
	raw, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": workspace.MediaChunkBytes})
	if err != nil {
		t.Fatal(err)
	}
	chunk := decodeResult(t, raw)
	decoded, err := base64.StdEncoding.DecodeString(chunk["bytes"].(string))
	if err != nil || chunk["offset"] != float64(0) || chunk["eof"] != true || !bytesEqual(decoded, payload) {
		t.Fatalf("read=%v decoded=%x err=%v", chunk, decoded, err)
	}
	if base64.StdEncoding.EncodeToString(decoded) != chunk["bytes"].(string) {
		t.Fatal("base64 is not canonical")
	}
	closeRaw, err := client.RPC("WorkspaceMediaClose", map[string]any{"handle": handle})
	if err != nil {
		t.Fatal(err)
	}
	closed := decodeResult(t, closeRaw)
	if closed["closed"] != true {
		t.Fatalf("close=%v", closed)
	}
	again, err := client.RPC("WorkspaceMediaClose", map[string]any{"handle": handle})
	if err != nil || decodeResult(t, again)["closed"] != true {
		t.Fatalf("idempotent close err=%v", err)
	}
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func TestWorkspaceMediaRPCRejectsRangeAndUnknownHandle(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "cat.png", tinyPNG())
	_, client := runtimeRPCClient(t, fake)
	handle := openMedia(t, client, "cat.png")["handle"].(string)
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 0, "length": workspace.MediaChunkBytes + 1}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("oversize length err=%v", err)
	}
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": handle, "offset": 99_999, "length": 1}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("offset err=%v", err)
	}
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{"handle": "media_" + "aa000000000000000000000000000000", "offset": 0, "length": 1}); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("unknown handle err=%v", err)
	}
}

func TestWorkspaceMediaRPCKeepsWorkspaceAndPaneReadsResponsive(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "cat.png", tinyPNG())
	engine, client := runtimeRPCClient(t, fake)
	hold := make(chan struct{})
	entered := make(chan struct{}, 1)
	engine.mediaTestHold = hold
	engine.mediaTestEntered = entered
	done := make(chan error, 1)
	go func() {
		_, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "cat.png"})
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("media open did not take a slot")
	}
	other := attachPhone(t, engine)
	if _, err := other.RPC("WorkspaceRead", map[string]any{"pane_id": "w0:p1", "path": "src/app.ts"}); err != nil {
		t.Fatalf("workspace read during media: %v", err)
	}
	if _, err := other.RPC("PaneRead", map[string]any{"pane_id": "w0:p1", "source": "visible", "format": "text", "lines": 20}); err != nil {
		t.Fatalf("pane read during media: %v", err)
	}
	close(hold)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceMediaRPCHandleQuotaAndExpiry(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	for i := 0; i < 5; i++ {
		if err := os.WriteFile(filepath.Join(root, "f"+string(rune('a'+i))+".bin"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	engine, client := runtimeRPCClient(t, fake)
	var last string
	for i := 0; i < 4; i++ {
		name := "f" + string(rune('a'+i)) + ".bin"
		last = openMedia(t, client, name)["handle"].(string)
	}
	if _, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "fe.bin"}); err == nil || err.Error() != "rate_limited" {
		t.Fatalf("session quota err=%v", err)
	}
	engine.media.mu.Lock()
	h := engine.media.byHandle[last]
	h.deadline = time.Now().Add(-time.Second)
	engine.media.mu.Unlock()
	engine.mediaExpire(last)
	opened := openMedia(t, client, "fe.bin")
	if opened["handle"] == "" {
		t.Fatal("expected a handle after expiry")
	}
}

func TestWorkspaceMediaOpenAfterDisconnectDoesNotInstall(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "cat.png", tinyPNG())
	engine, client := runtimeRPCClient(t, fake)
	hold := make(chan struct{})
	entered := make(chan struct{}, 1)
	engine.mediaTestHold = hold
	engine.mediaTestEntered = entered
	done := make(chan error, 1)
	go func() {
		_, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "cat.png"})
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("open did not start")
	}
	engine.closeSession(clientRoute(engine, client), "", false)
	close(hold)
	if err := <-done; err == nil {
		t.Fatal("expected open to fail after disconnect")
	}
	engine.media.mu.Lock()
	leaked := len(engine.media.byHandle)
	engine.media.mu.Unlock()
	if leaked != 0 {
		t.Fatalf("leaked %d media handles after disconnect", leaked)
	}
}

func TestWorkspaceMediaRPCUnknownOpStaysUnknownOp(t *testing.T) {
	_, fake := workspaceRPCFixture(t)
	_, client := runtimeRPCClient(t, fake)
	if _, err := client.RPC("WorkspaceMediaPreview", map[string]any{"pane_id": "w0:p1"}); err == nil || err.Error() != "unknown_op" {
		t.Fatalf("unknown media op err=%v", err)
	}
}
