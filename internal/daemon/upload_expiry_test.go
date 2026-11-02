package daemon

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/workspace"
)

// TestUploadExpiredTombstoneRejectsOperations proves a handle that was looked
// up and then concurrently tombstoned by expiry/shutdown cannot observe a nil
// stage, perform a write, or fabricate a cancelled/committed state — it is
// refused with workspace_not_found on every phase.
func TestUploadExpiredTombstoneRejectsOperations(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("expired tombstone")
	uuid := testUUID(900)
	setUpFS(t, client, uuid, "op_tombbegin0000001", "t.bin", data, "application/octet-stream", "w0:p1")

	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	entry.mu.Lock()
	entry.expired = true
	entry.stage = nil // simulate post-expiry torn state
	entry.mu.Unlock()

	for _, op := range []string{"WorkspaceUploadStatus", "WorkspaceUploadWrite", "WorkspaceUploadCommit", "WorkspaceUploadCancel"} {
		params := map[string]any{"pane_id": "w0:p1", "upload_id": uuid}
		if op == "WorkspaceUploadWrite" {
			params["operation_id"] = "op_tombwrite0000001"
			params["offset"] = 0
			params["data_b64"] = base64.StdEncoding.EncodeToString([]byte("x"))
		} else if op == "WorkspaceUploadCommit" {
			params["operation_id"] = "op_tombcommit000001"
		} else if op == "WorkspaceUploadCancel" {
			params["operation_id"] = "op_tombcancel000001"
		}
		if _, err := client.RPCTimeout(op, params, testUploadTimeout); err == nil || err.Error() != "workspace_not_found" {
			t.Fatalf("%s on expired handle err=%v", op, err)
		}
	}
}

// TestUploadExpiryRacingFinalizationKeepsTerminal proves an old expiry callback
// that waited on entry.mu while a finalization re-armed a later terminal expiry
// does not delete the freshly-finalized record (expiresAt is rechecked under
// the lock).
func TestUploadExpiryRacingFinalizationKeepsTerminal(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("finalized terminal")
	uuid := testUUID(901)
	setUpFS(t, client, uuid, "op_racebegin0000001", "f.bin", data, "application/octet-stream", "w0:p1")
	uploadWrite(t, client, uuid, "op_racewrite0000001", 0, data, "w0:p1")
	if _, err := uploadCommit(t, client, uuid, "op_racecommit000001", "w0:p1"); err != nil {
		t.Fatalf("commit failed: %v", err)
	}

	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	if entry == nil {
		t.Fatal("committed entry missing")
	}
	entry.mu.Lock()
	expiresAtAfterFinalize := entry.expiresAt
	entry.mu.Unlock()
	if time.Now().After(expiresAtAfterFinalize) {
		t.Fatal("terminal expiry was not re-armed into the future")
	}

	// The delayed (old) expiry callback now fires: it must see the later
	// expiresAt and refuse to tombstone/remove the committed record.
	engine.expireUpload(entry)

	entry.mu.Lock()
	retained := !entry.expired
	state := entry.state
	entry.mu.Unlock()
	if !retained || state != uploadStateCommitted {
		t.Fatalf("expiry discarded fresh terminal retention: retained=%v state=%q", retained, state)
	}
	st, err := uploadStatus(t, client, uuid, "w0:p1")
	if err != nil || st["state"] != "committed" {
		t.Fatalf("terminal record lost to racing expiry: st=%v err=%v", st, err)
	}
	entry.mu.Lock()
	finalPath := entry.finalPath
	entry.mu.Unlock()
	if _, err := os.Stat(finalPath); err != nil {
		t.Fatalf("committed file missing after racing expiry: %v", err)
	}
}

// TestUploadExpiredPublishedUnknownPreservesFile proves an expired
// published-unknown stage closes its descriptor but preserves the final file,
// and a later Status refuses with workspace_not_found (never a false cancelled
// response).
func TestUploadExpiredPublishedUnknownPreservesFile(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("unknown-published bytes")
	uuid := testUUID(902)
	setUpFS(t, client, uuid, "op_unkbegin00000001", "u.bin", data, "application/octet-stream", "w0:p1")
	uploadWrite(t, client, uuid, "op_unkwrite00000001", 0, data, "w0:p1")

	restore := setCommitFault(func(_ *uploadEntry, cerr error) error {
		if cerr == nil {
			return workspace.ErrMutationUnknown
		}
		return cerr
	})
	if _, err := uploadCommit(t, client, uuid, "op_unkcommit0000001", "w0:p1"); err == nil || err.Error() != "unknown_outcome" {
		restore()
		t.Fatalf("expected unknown_outcome, got %v", err)
	}
	restore()

	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	entry.mu.Lock()
	rel := entry.stage.FinalRel()
	entry.mu.Unlock()
	finalPath := filepath.Join(uploadBaseOf(t, entry.root), filepath.FromSlash(rel))
	if _, err := os.Stat(finalPath); err != nil {
		t.Fatalf("published unknown file missing before expiry: %v", err)
	}

	entry.mu.Lock()
	entry.expiresAt = time.Now().Add(-time.Hour)
	entry.mu.Unlock()
	engine.expireUpload(entry)

	if _, err := os.Stat(finalPath); err != nil {
		t.Fatalf("expiry deleted a published-unknown file: %v", err)
	}
	engine.uploads.mu.Lock()
	_, stillIn := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	engine.uploads.mu.Unlock()
	if stillIn {
		t.Fatal("expired published-unknown record retained in registry")
	}
	if _, err := uploadStatus(t, client, uuid, "w0:p1"); err == nil || err.Error() != "workspace_not_found" {
		t.Fatalf("status after expired published-unknown must be workspace_not_found, not cancelled/committed, got %v", err)
	}
}

// TestUploadReconcileCompactsReceipts proves successful reconciliation discards
// chunk receipts while the original uncertain Commit stays non-reexecuting and
// no fresh terminal call grows the receipt map.
func TestUploadReconcileCompactsReceipts(t *testing.T) {
	_, _, engine, client := uploadFixture(t)
	data := []byte("compact receipts")
	uuid := testUUID(903)
	writeOp := "op_compactwrite0001"
	commitOp := "op_compactcommit001"
	setUpFS(t, client, uuid, "op_compactbegin0001", "c.bin", data, "application/octet-stream", "w0:p1")
	uploadWrite(t, client, uuid, writeOp, 0, data, "w0:p1")

	restore := setCommitFault(func(_ *uploadEntry, cerr error) error {
		if cerr == nil {
			return workspace.ErrMutationUnknown
		}
		return cerr
	})
	if _, err := uploadCommit(t, client, uuid, commitOp, "w0:p1"); err == nil || err.Error() != "unknown_outcome" {
		restore()
		t.Fatalf("expected unknown_outcome, got %v", err)
	}
	restore()

	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	entry.opMu.Lock()
	before := len(entry.opSeen)
	entry.opMu.Unlock()
	if before < 2 {
		t.Fatalf("expected write+commit receipts before reconcile, got %d", before)
	}

	if st, err := uploadStatus(t, client, uuid, "w0:p1"); err != nil || st["state"] != "committed" {
		t.Fatalf("reconcile via status failed: st=%v err=%v", st, err)
	}

	entry.opMu.Lock()
	after := len(entry.opSeen)
	_, keepsCommit := entry.opSeen[commitOp]
	_, keepsWrite := entry.opSeen[writeOp]
	entry.opMu.Unlock()
	if after != 1 || !keepsCommit || keepsWrite {
		t.Fatalf("receipts not compacted to terminal identity: after=%d keepsCommit=%v keepsWrite=%v", after, keepsCommit, keepsWrite)
	}

	// The original uncertain Commit remains non-reexecuting (never re-publishes).
	if _, err := uploadCommit(t, client, uuid, commitOp, "w0:p1"); err == nil || err.Error() != "unknown_outcome" {
		t.Fatalf("uncertain commit must stay non-reexecuting, got %v", err)
	}
}

// TestUploadAbortInitSetsTerminalExpiry proves a Begin that reserves quota but
// then fails staging (so no pending timer was ever armed) leaves a cancelled
// terminal entry with a non-nil future expiry timer and released quota, keeps
// its failure receipt non-restaging and session-owned, and is reaped by the
// standard expiry without touching an unrelated staging-path file. CloseUploads
// drains a second aborted-init entry.
func TestUploadAbortInitSetsTerminalExpiry(t *testing.T) {
	root, _, engine, client := uploadFixture(t)
	// Make staging fail AFTER reservation: the base exists as a dir and
	// <base>/.staging is a regular file, so the quota scan (which opens the
	// base and skips .staging) passes, but BeginAttachment's chain creation
	// fails -> the abortInit path.
	attachments := uploadBaseOf(t, root)
	if err := os.MkdirAll(attachments, 0o700); err != nil {
		t.Fatal(err)
	}
	stagingFile := filepath.Join(attachments, ".staging")
	if err := os.WriteFile(stagingFile, []byte("staging-as-file"), 0o600); err != nil {
		t.Fatal(err)
	}

	opA := "op_abortbegin0000001"
	uuid := testUUID(910)
	beginA := map[string]any{
		"pane_id": "w0:p1", "upload_id": uuid, "operation_id": opA,
		"name": "a.bin", "size": 5, "sha256": optsChecksum([]byte("12345")), "mime": "application/octet-stream",
	}
	if _, err := client.RPCTimeout("WorkspaceUploadBegin", beginA, testUploadTimeout); err == nil {
		t.Fatal("staging-failing begin must error after reservation")
	}

	entry := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	if entry == nil {
		t.Fatal("aborted entry missing")
	}
	entry.mu.Lock()
	state, accounted, timerArmed := entry.state, entry.accounted, entry.timer != nil
	deadlineFuture := entry.expiresAt.After(time.Now())
	entry.mu.Unlock()
	if state != uploadStateCancelled || accounted || !timerArmed || !deadlineFuture {
		t.Fatalf("aborted entry state=%q accounted=%v timer=%v futureDeadline=%v", state, accounted, timerArmed, deadlineFuture)
	}
	engine.uploads.mu.Lock()
	pending, active := engine.uploads.pendingBytes, engine.uploads.active
	engine.uploads.mu.Unlock()
	if pending != 0 || active != 0 {
		t.Fatalf("aborted-init quota not released: pending=%d active=%d", pending, active)
	}

	// Same Begin replayed: cached error, no restage (never re-runs staging).
	if _, err := client.RPCTimeout("WorkspaceUploadBegin", beginA, testUploadTimeout); err == nil {
		t.Fatal("replayed failing begin must stay failing")
	}
	entry.mu.Lock()
	state2, stage2 := entry.state, entry.stage
	entry.mu.Unlock()
	if state2 != uploadStateCancelled || stage2 != nil {
		t.Fatalf("replay restaged entry: state=%q stage=%v", state2, stage2)
	}

	// A different runtime session must not be served the cached receipt.
	beta := map[string]any{"session": "beta", "pane_id": "w0:p1", "upload_id": uuid, "operation_id": opA,
		"name": "a.bin", "size": 5, "sha256": optsChecksum([]byte("12345")), "mime": "application/octet-stream"}
	if _, err := client.RPCTimeout("WorkspaceUploadBegin", beta, testUploadTimeout); err == nil || err.Error() != "forbidden" {
		t.Fatalf("cross-session cached receipt should be forbidden, got %v", err)
	}

	// Deterministically advance the terminal deadline and run expiry: the
	// aborted metadata is reaped without touching the unrelated .staging file.
	entry.mu.Lock()
	entry.expiresAt = time.Now().Add(-time.Hour)
	entry.mu.Unlock()
	engine.expireUpload(entry)
	engine.uploads.mu.Lock()
	_, stillIn := engine.uploads.byKey[uploadKey(client.DeviceID, uuid)]
	engine.uploads.mu.Unlock()
	if stillIn {
		t.Fatal("aborted entry not reaped by expiry")
	}
	if _, err := os.Stat(stagingFile); err != nil {
		t.Fatalf("expiry touched unrelated .staging file: %v", err)
	}

	// CloseUploads drains a second aborted-init entry (cleanup fixture).
	uuidB := testUUID(911)
	beginB := map[string]any{"pane_id": "w0:p1", "upload_id": uuidB, "operation_id": "op_abortbegin0000002",
		"name": "b.bin", "size": 5, "sha256": optsChecksum([]byte("67890")), "mime": "application/octet-stream"}
	if _, err := client.RPCTimeout("WorkspaceUploadBegin", beginB, testUploadTimeout); err == nil {
		t.Fatal("second failing begin must error")
	}
	engine.CloseUploads()
	engine.uploads.mu.Lock()
	left := len(engine.uploads.byKey)
	engine.uploads.mu.Unlock()
	if left != 0 {
		t.Fatalf("CloseUploads left %d entries", left)
	}
	if _, err := os.Stat(stagingFile); err != nil {
		t.Fatalf("shutdown touched unrelated .staging file: %v", err)
	}
}
