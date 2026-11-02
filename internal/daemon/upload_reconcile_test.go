package daemon

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/phone"
	"pairfob/internal/workspace"
)

// TestUploadBindsRuntimeSession enforces exact pane ownership across named
// runtime sessions: the same pane id AND same canonical root reached through a
// different runtime session is a different pane and must be rejected.
func TestUploadBindsRuntimeSession(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("session-bound bytes")
	uuid := testUUID(800)

	// Begin in runtime session "alpha" (fake returns the same root for both).
	raw, err := client.RPCTimeout("WorkspaceUploadBegin", map[string]any{
		"session": "alpha", "pane_id": "w0:p1", "upload_id": uuid,
		"operation_id": "op_sesbegin00000001", "name": "s.txt", "size": len(data),
		"sha256": optsChecksum(data), "mime": "text/plain",
	}, testUploadTimeout)
	if err != nil || decodeResult(t, raw)["state"] != "uploading" {
		t.Fatalf("begin in session alpha: raw=%s err=%v", raw, err)
	}

	// Same pane id + same root, but a different runtime session -> forbidden on
	// every phase, including read-only Status and Cancel.
	if _, err := uploadStatusSession(t, client, uuid, "w0:p1", "beta"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("status cross-session must be forbidden, got %v", err)
	}
	if _, err := uploadWriteSession(t, client, uuid, "op_seswrite00000001", 0, data, "w0:p1", "beta"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("write cross-session must be forbidden, got %v", err)
	}
	if _, err := uploadCommitSession(t, client, uuid, "op_sescommit0000001", "w0:p1", "beta"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("commit cross-session must be forbidden, got %v", err)
	}
	if _, err := uploadCancelSession(t, client, uuid, "op_sescancel0000001", "w0:p1", "beta"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("cancel cross-session must be forbidden, got %v", err)
	}

	// The owning session ("alpha") still owns the upload.
	if _, err := uploadWriteSession(t, client, uuid, "op_seswrite00000002", 0, data, "w0:p1", "alpha"); err != nil {
		t.Fatalf("owning session write failed: %v", err)
	}
	if st, err := uploadStatusSession(t, client, uuid, "w0:p1", "alpha"); err != nil || st["offset"] != float64(len(data)) {
		t.Fatalf("owning session status: %v err=%v", st, err)
	}
	_ = engine
}

// TestUploadCommitUncertainThenStatusReconciles drives the real Commit into an
// uncertain outcome (via a fault seam equivalent to W's unexported
// attachErrHook) and proves: the entry stays logically pending, the commit
// receipt is non-reexecuting, and a later Status reconciles it to committed
// (durable) exactly once without re-publishing.
func TestUploadCommitUncertainThenStatusReconciles(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("uncertain-publish body")
	uuid := testUUID(810)
	setUpFS(t, client, uuid, "op_uncbegin00000001", "u.txt", data, "text/plain", "w0:p1")
	uploadWrite(t, client, uuid, "op_uncwrite00000001", 0, data, "w0:p1")

	restore := setCommitFault(func(_ *uploadEntry, cerr error) error {
		if cerr == nil {
			return workspace.ErrMutationUnknown
		}
		return cerr
	})
	defer restore()

	// Commit reports uncertain; the entry must NOT become committed and the
	// same operation must never re-publish (non-reexecuting receipt).
	_, err := uploadCommit(t, client, uuid, "op_unccommit0000001", "w0:p1")
	if err == nil || err.Error() != "unknown_outcome" {
		t.Fatalf("expected unknown_outcome from uncertain commit, got %v", err)
	}
	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	if entry == nil {
		t.Fatal("entry missing after uncertain commit")
	}
	entry.mu.Lock()
	state, committedStage := entry.state, entry.stage.Committed()
	entry.mu.Unlock()
	if state != uploadStateUploading || !committedStage {
		t.Fatalf("after uncertain commit: state=%q stageCommitted=%v", state, committedStage)
	}
	if _, err := uploadCommit(t, client, uuid, "op_unccommit0000001", "w0:p1"); err == nil || err.Error() != "unknown_outcome" {
		t.Fatalf("re-sending uncertain commit must not re-publish, got %v", err)
	}

	restore() // disable the fault; reconciliation below observes the durable publish

	status, err := uploadStatus(t, client, uuid, "w0:p1")
	if err != nil || status["state"] != "committed" || status["offset"] != float64(len(data)) {
		t.Fatalf("post-reconcile status=%v err=%v", status, err)
	}
	path, _ := status["path"].(string)
	if path == "" {
		t.Fatalf("reconciled committed missing path: %v", status)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("reconciled file missing: %v", err)
	}
	engine.uploads.mu.Lock()
	pending, active := engine.uploads.pendingBytes, engine.uploads.active
	engine.uploads.mu.Unlock()
	if pending != 0 || active != 0 {
		t.Fatalf("quota not released once after reconcile: pending=%d active=%d", pending, active)
	}
}

// TestUploadStatusAndCancelReconcilePublishedStage proves that once a stage's
// rename has actually published, Status and Cancel reconcile to committed
// (never claim uploading/cancelled, never abort/delete) even when the daemon
// had not yet recorded the committed state.
func TestUploadStatusAndCancelReconcilePublishedStage(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("directly-published body")
	uuid := testUUID(820)
	setUpFS(t, client, uuid, "op_dpubegin00000001", "p.bin", data, "application/octet-stream", "w0:p1")
	uploadWrite(t, client, uuid, "op_dpwrite000000001", 0, data, "w0:p1")

	// Publish through the real stage directly (the daemon handler did not
	// record committed), modelling the post-rename reconcile window.
	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	entry.mu.Lock()
	_, cerr := entry.stage.Commit(entry.size, entry.sha256)
	entry.mu.Unlock()
	if cerr != nil {
		t.Fatalf("direct stage publish failed: %v", cerr)
	}

	// Status reconciles to committed with exact offset/path.
	status, err := uploadStatus(t, client, uuid, "w0:p1")
	if err != nil || status["state"] != "committed" || status["offset"] != float64(len(data)) {
		t.Fatalf("status after published stage=%v err=%v", status, err)
	}
	path, _ := status["path"].(string)
	if path == "" {
		t.Fatalf("reconciled committed missing path")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("published file missing: %v", err)
	}

	// A second published upload exercises Cancel-after-publish -> committed,
	// and the file is preserved (never aborted/removed).
	uuid2 := testUUID(821)
	setUpFS(t, client, uuid2, "op_dpbegincancel0001", "p2.bin", data, "application/octet-stream", "w0:p1")
	uploadWrite(t, client, uuid2, "op_dpwrcancel0000001", 0, data, "w0:p1")
	entry2 := engine.uploads.byKey[uploadKey(client.DeviceID, uuid2)]
	entry2.mu.Lock()
	res2, cerr2 := entry2.stage.Commit(entry2.size, entry2.sha256)
	entry2.mu.Unlock()
	if cerr2 != nil {
		t.Fatalf("second direct publish failed: %v", cerr2)
	}
	cancel, err := uploadCancel(t, client, uuid2, "op_dpcnclcancel0001", "w0:p1")
	if err != nil || cancel["state"] != "committed" {
		t.Fatalf("cancel after published stage=%v err=%v", cancel, err)
	}
	if _, err := os.Stat(filepath.Join(uploadBaseOf(t, entry2.root), filepath.FromSlash(res2.Rel))); err != nil {
		t.Fatalf("cancel removed a published file: %v", err)
	}
}

// TestUploadLazyStagingCleanupPreservesActiveRemovesStale proves the wiring:
// a Begin-triggered cleanup with active server UUIDs exempted never removes a
// live stage and reclaims an abandoned (>24h) validated staging dir.
func TestUploadLazyStagingCleanupPreservesActiveRemovesStale(t *testing.T) {
	root, _, engine, client := uploadFixture(t)

	// Active upload that must survive cleanup.
	uuidActive := testUUID(830)
	setUpFS(t, client, uuidActive, "op_cleanactive00001", "live.bin", []byte("live"), "application/octet-stream", "w0:p1")
	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuidActive)]
	entry.mu.Lock()
	activeID := entry.serverID
	entry.mu.Unlock()
	activeDir := filepath.Join(uploadBaseOf(t, root), ".staging", activeID)
	if _, err := os.Stat(activeDir); err != nil {
		t.Fatalf("active stage dir missing before cleanup: %v", err)
	}

	// Abandoned stale staging dir (valid owned marker, >24h old).
	staleUUID := testUUID(840)
	stagingBase := filepath.Join(uploadBaseOf(t, root), ".staging")
	staleDir := filepath.Join(stagingBase, staleUUID)
	if err := os.MkdirAll(staleDir, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := "pairfob-attachment-stage.v1\nattachment.bin\n"
	if err := os.WriteFile(filepath.Join(staleDir, ".owned"), []byte(marker), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staleDir, "attachment.bin"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-25 * time.Hour)
	if err := os.Chtimes(staleDir, old, old); err != nil {
		t.Fatal(err)
	}

	// A fresh Begin triggers cleanup on the root.
	uuidNew := testUUID(850)
	setUpFS(t, client, uuidNew, "op_cleannew00000001", "new.bin", []byte("new"), "application/octet-stream", "w0:p1")

	if _, err := os.Stat(staleDir); !os.IsNotExist(err) {
		t.Fatalf("stale staging dir was not reclaimed (err=%v)", err)
	}
	if _, err := os.Stat(activeDir); err != nil {
		t.Fatalf("active stage dir was removed by cleanup: %v", err)
	}
	if _, err := uploadStatus(t, client, uuidActive, "w0:p1"); err != nil {
		t.Fatalf("active upload broken after cleanup: %v", err)
	}
}

// --- helpers with an explicit runtime session ---

func uploadStatusSession(t *testing.T, client *phone.Client, uuid, pane, session string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadStatus", map[string]any{"pane_id": pane, "upload_id": uuid, "session": session}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func uploadWriteSession(t *testing.T, client *phone.Client, uuid, op string, offset int, data []byte, pane, session string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadWrite", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op, "offset": offset,
		"data_b64": base64.StdEncoding.EncodeToString(data), "session": session,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func uploadCommitSession(t *testing.T, client *phone.Client, uuid, op, pane, session string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op, "session": session,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func uploadCancelSession(t *testing.T, client *phone.Client, uuid, op, pane, session string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadCancel", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op, "session": session,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func uploadCommit(t *testing.T, client *phone.Client, uuid, op, pane string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadCommit", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}

func uploadCancel(t *testing.T, client *phone.Client, uuid, op, pane string) (map[string]any, error) {
	t.Helper()
	raw, err := client.RPCTimeout("WorkspaceUploadCancel", map[string]any{
		"pane_id": pane, "upload_id": uuid, "operation_id": op,
	}, testUploadTimeout)
	if err != nil {
		return nil, err
	}
	return decodeResult(t, raw), nil
}
