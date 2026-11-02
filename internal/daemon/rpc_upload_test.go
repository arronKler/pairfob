package daemon

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/phone"
	"pairfob/internal/runtime"
	"pairfob/internal/workspace"
)

const testUploadTimeout = 15 * time.Second

func uploadFixture(t *testing.T) (string, *runtime.Fake, *Engine, *phone.Client) {
	t.Helper()
	root, fake := workspaceRPCFixture(t)
	engine, client := runtimeRPCClient(t, fake)
	// Record the engine the client talks to so latency/stall tests that need
	// to swap the runtime (engineWithRuntime) can locate it. Guarded by the
	// fact these tests are never run with t.Parallel and each fixture is
	// isolated.
	currentFixtureEngine = engine
	t.Cleanup(func() { currentFixtureEngine = nil })
	return root, fake, engine, client
}

func testUUID(n int) string {
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
}

func optsChecksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func setUpFS(t *testing.T, client *phone.Client, uuid, op string, name string, data []byte, mime, pane string) map[string]any {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadBegin", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op,
		"name": name, "size": len(data), "sha256": optsChecksum(data), "mime": mime,
	}, testUploadTimeout)
	if err != nil {
		t.Fatalf("begin err=%v", err)
	}
	return decodeResult(t, raw)
}

func uploadWrite(t *testing.T, client *phone.Client, uuid, op string, offset int, data []byte, pane string) (map[string]any, error) {
	t.Helper()
	b64 := base64.StdEncoding.EncodeToString(data)
	raw, err := client.RPCTimeout("WorkspaceUploadWrite", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op,
		"offset": offset, "data_b64": b64,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func uploadStatus(t *testing.T, client *phone.Client, uuid, pane string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadStatus", map[string]any{
		"pane_id": pane, "upload_id": uuid,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func TestUploadBeginWriteStatusCommitLifecycle(t *testing.T) {
	_, _, _, client := uploadFixture(t)
	data := []byte("hello pairfob upload lifecycle")
	uuid := testUUID(1)
	begin := setUpFS(t, client, uuid, "op_begin000000000001", "hello.txt", data, "text/plain", "w0:p1")
	if begin["state"] != "uploading" || begin["size"] != float64(len(data)) || begin["upload_id"] != uuid {
		t.Fatalf("begin=%v", begin)
	}

	write, err := uploadWrite(t, client, uuid, "op_write000000000001", 0, data, "w0:p1")
	if err != nil {
		t.Fatal(err)
	}
	if write["offset"] != float64(len(data)) || write["state"] != "uploading" {
		t.Fatalf("write=%v", write)
	}

	status, err := uploadStatus(t, client, uuid, "w0:p1")
	if err != nil {
		t.Fatal(err)
	}
	if status["state"] != "uploading" || status["offset"] != float64(len(data)) {
		t.Fatalf("status=%v", status)
	}

	raw, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": "op_commit000000000001",
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	committed := decodeResult(t, raw)
	if committed["state"] != "committed" || committed["offset"] != float64(len(data)) || committed["name"] != "hello.txt" || committed["mime"] != "text/plain" {
		t.Fatalf("committed=%v", committed)
	}
	if committed["relative_path"] == "" || committed["path"] == "" {
		t.Fatalf("committed missing final path: %v", committed)
	}
}

// uploadBaseOf returns the attachment base of a pane root.
func uploadBaseOf(t *testing.T, root string) string {
	t.Helper()
	base, err := workspace.AttachBase(root)
	if err != nil {
		t.Fatalf("attach base: %v", err)
	}
	return base
}

func TestUploadCommitReturnsAbsolutePathUnderBase(t *testing.T) {
	root, _, _, client := uploadFixture(t)
	data := []byte("\x89PNG fake")
	uuid := testUUID(3)
	setUpFS(t, client, uuid, "op_begin000000000003", "shot.png", data, "image/png", "w0:p1")
	if _, err := uploadWrite(t, client, uuid, "op_write000000000003", 0, data, "w0:p1"); err != nil {
		t.Fatal(err)
	}
	raw, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": "op_commit000000000003",
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	path, _ := decodeResult(t, raw)["path"].(string)
	base := uploadBaseOf(t, root)
	if !filepath.IsAbs(path) || !strings.HasPrefix(path, base+string(filepath.Separator)) {
		t.Fatalf("path %q is not absolute under base %q", path, base)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(data) {
		t.Fatalf("file at returned path: %q %v", got, err)
	}
}

func TestUploadReceiptReplayAndFailureNeverReexecutes(t *testing.T) {
	_, _, _, client := uploadFixture(t)
	data := make([]byte, uploadChunkBytes) // one full chunk
	for i := range data {
		data[i] = byte(i % 251)
	}
	uuid := testUUID(2)
	beginOp := "op_begin000000000002"
	begin := setUpFS(t, client, uuid, beginOp, "blob.bin", data, "application/octet-stream", "w0:p1")
	replayed, err := client.RPCTimeout("WorkspaceUploadBegin", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": beginOp,
		"name": "blob.bin", "size": len(data), "sha256": optsChecksum(data), "mime": "application/octet-stream",
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if string(replayed) != string(mustJSON(t, begin)) {
		t.Fatalf("begin replay changed result: first=%s second=%s", mustJSON(t, begin), replayed)
	}

	writeOp := "op_write000000000002"
	write, err := uploadWrite(t, client, uuid, writeOp, 0, data, "w0:p1")
	if err != nil {
		t.Fatal(err)
	}
	writeReplay, err := client.RPCTimeout("WorkspaceUploadWrite", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": writeOp,
		"offset": 0, "data_b64": base64.StdEncoding.EncodeToString(data),
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if string(writeReplay) != string(mustJSON(t, write)) {
		t.Fatalf("write replay changed result: first=%s second=%s", mustJSON(t, write), writeReplay)
	}

	// A write past EOF fails and is recorded; re-sending the same failing op
	// must never re-execute and must redeliver the recorded failure.
	failOp := "op_writefail0000000001"
	failParams := map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": failOp,
		"offset": len(data), "data_b64": base64.StdEncoding.EncodeToString([]byte("overflow")),
	}
	if _, err := client.RPCTimeout("WorkspaceUploadWrite", failParams, testUploadTimeout); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("expected oversized write failure, got %v", err)
	}
	if _, err := client.RPCTimeout("WorkspaceUploadWrite", failParams, testUploadTimeout); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("failed op must redeliver the recorded failure, got %v", err)
	}
	status, err := uploadStatus(t, client, uuid, "w0:p1")
	if err != nil {
		t.Fatal(err)
	}
	if status["offset"] != float64(len(data)) {
		t.Fatalf("failed write re-executed or advanced offset: status=%v", status)
	}

	// Commit then replay must return the identical committed receipt.
	commitOp := "op_commit000000000002"
	commitRaw, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": commitOp,
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	commitReplay, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": commitOp,
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if string(commitRaw) != string(commitReplay) {
		t.Fatalf("commit replay changed: first=%s second=%s", commitRaw, commitReplay)
	}
}

func TestUploadCancelledRetainedForStatusAndRepeatedQuotaCycles(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	// Repeated begin/cancel cycles must not leak reserved quota.
	for i := 0; i < 8; i++ {
		uuid := testUUID(100 + i)
		begin := setUpFS(t, client, uuid, fmt.Sprintf("op_begincycle%08d", i), "f.bin", []byte("payload"), "application/octet-stream", "w0:p1")
		if begin["state"] != "uploading" {
			t.Fatalf("cycle %d begin=%v", i, begin)
		}
		cancelRaw, err := client.RPCTimeout("WorkspaceUploadCancel", map[string]any{
			"pane_id": "w0:p1", "upload_id": uuid, "operation_id": fmt.Sprintf("op_cancelcycle%08d", i),
		}, testUploadTimeout)
		if err != nil {
			t.Fatalf("cycle %d cancel err=%v", i, err)
		}
		cancelled := decodeResult(t, cancelRaw)
		if cancelled["state"] != "cancelled" {
			t.Fatalf("cycle %d cancelled=%v", i, cancelled)
		}
	}
	engine.uploads.mu.Lock()
	pending, active := engine.uploads.pendingBytes, engine.uploads.active
	engine.uploads.mu.Unlock()
	if pending != 0 || active != 0 {
		t.Fatalf("quota leaked after cancel cycles: pending=%d active=%d", pending, active)
	}

	// A fresh begin after the cancelled cycles must still be accepted.
	uuid := testUUID(200)
	setUpFS(t, client, uuid, "op_begincycleafter0001", "ok.bin", []byte("data"), "application/octet-stream", "w0:p1")

	// Cancelled entries are retained so Status reconciles them as cancelled.
	status, err := uploadStatus(t, client, testUUID(100), "w0:p1")
	if err != nil {
		t.Fatal(err)
	}
	if status["state"] != "cancelled" {
		t.Fatalf("status of cancelled upload=%v", status)
	}
}

func TestUploadBindingRejectsWrongPaneSameRoot(t *testing.T) {
	root, fake, _, client := uploadFixture(t)
	// A second pane anchored to the exact same root: same-root different pane
	// must be forbidden, not silently served.
	fake.Snap.Panes = append(fake.Snap.Panes, runtime.Pane{
		PaneID: "w0:p2", WorkspaceID: "w0", TabID: "w0:t1", Cwd: root,
	})
	data := []byte("bound pane content")
	uuid := testUUID(300)
	setUpFS(t, client, uuid, "op_beginbind0000000001", "bind.txt", data, "text/plain", "w0:p1")

	if _, err := uploadStatus(t, client, uuid, "w0:p2"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("different pane on same root must be forbidden, got %v", err)
	}
	if _, err := uploadWrite(t, client, uuid, "op_writebind0000000001", 0, data, "w0:p2"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("different pane write must be forbidden, got %v", err)
	}
	if _, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": "w0:p2", "upload_id": uuid, "operation_id": "op_commitbind00000001",
	}, testUploadTimeout); err == nil || err.Error() != "forbidden" {
		t.Fatalf("different pane commit must be forbidden, got %v", err)
	}
	// The bound pane still owns it.
	if _, err := uploadWrite(t, client, uuid, "op_writebind0000000002", 0, data, "w0:p1"); err != nil {
		t.Fatalf("owning pane write failed: %v", err)
	}
}

func TestUploadRejectsDifferentDevice(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("device private")
	uuid := testUUID(400)
	setUpFS(t, client, uuid, "op_begindevice0000001", "d.bin", data, "application/octet-stream", "w0:p1")

	other := attachPhone(t, engine)
	if _, err := uploadStatus(t, other, uuid, "w0:p1"); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("other device must not see the upload, got %v", err)
	}
	if _, err := uploadWrite(t, other, uuid, "op_writedevice0000001", 0, data, "w0:p1"); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("other device write must be rejected, got %v", err)
	}
}

func TestUploadReconnectRetainsHandleAndResumes(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	half := make([]byte, 64)
	rest := make([]byte, 64)
	for i := range half {
		half[i] = byte('a' + i%26)
		rest[i] = byte('A' + i%26)
	}
	data := append(append([]byte{}, half...), rest...)
	uuid := testUUID(500)
	setUpFS(t, client, uuid, "op_beginrecon000000001", "resume.bin", data, "application/octet-stream", "w0:p1")
	if _, err := uploadWrite(t, client, uuid, "op_writerecon000000001", 0, half, "w0:p1"); err != nil {
		t.Fatal(err)
	}

	// Normal disconnect: upload handle and expiry timer must survive.
	engine.closeSession(clientRoute(engine, client), "", false)
	engine.uploads.mu.Lock()
	_, retained := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	engine.uploads.mu.Unlock()
	if !retained {
		t.Fatal("upload handle was dropped on normal session close")
	}

	// Reconnect as the same device (fresh session) and resume via Status+Write.
	reconnected := reconnectSameDevice(t, engine, client.DeviceID, client.PSK, client.DaemonPK)

	status, err := uploadStatus(t, reconnected, uuid, "w0:p1")
	if err != nil {
		t.Fatal(err)
	}
	if status["state"] != "uploading" || status["offset"] != float64(len(half)) {
		t.Fatalf("reconnect status=%v", status)
	}
	if _, err := uploadWrite(t, reconnected, uuid, "op_writerecon000000002", len(half), rest, "w0:p1"); err != nil {
		t.Fatalf("resume write failed: %v", err)
	}
	commitRaw, err := reconnected.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": "op_commitrecon0000001",
	}, testUploadTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if decodeResult(t, commitRaw)["state"] != "committed" {
		t.Fatalf("reconnect commit=%s", commitRaw)
	}
}

// reconnectSameDevice opens a brand-new session for the same device identity so
// the immutable device-keyed upload handle can be inspected and resumed after
// a normal disconnect.
func reconnectSameDevice(t *testing.T, engine *Engine, deviceID string, psk []byte, daemonPK []byte) *phone.Client {
	t.Helper()
	clientSide, hubClient := mux.NewPipePair(128)
	stop := pump(t, hubClient, func(frame envelope.Frame) { engine.Hub.HandleClient(hubClient, frame) })
	t.Cleanup(func() { close(stop) })
	client := &phone.Client{Conn: clientSide, DeviceID: deviceID, PSK: psk, DaemonPK: daemonPK}
	if err := client.Resume(engine.DaemonID); err != nil {
		t.Fatal(err)
	}
	return client
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
