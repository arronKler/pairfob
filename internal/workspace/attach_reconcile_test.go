//go:build unix

// Focused tests for the after-publish integration contract: post-rename
// final-entry verification, non-publishing reconciliation (durability-only
// fsync retry), foreign-replacement preservation, fsync of the full creation
// chain, exact marker naming before commit, and no staging leftovers after a
// successful commit.
package workspace

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync"
	"testing"

	"golang.org/x/sys/unix"
)

// commitUpload is a helper: Begin, single WriteAt, Commit.
func commitUpload(t *testing.T, root, serverID, mime string, data []byte) (*AttachStage, AttachCommitResult, error) {
	t.Helper()
	stage, err := BeginAttachment(root, serverID, mime, int64(len(data)))
	if err != nil {
		t.Fatalf("begin %s: %v", serverID, err)
	}
	if len(data) > 0 {
		if err := stage.WriteAt(0, data); err != nil {
			t.Fatalf("write %s: %v", serverID, err)
		}
	}
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	return stage, res, err
}

// TestAttachmentReconcileAfterFsyncFailure covers the core unknown-outcome
// path: the post-rename fsync fails (injected), Commit returns
// ErrMutationUnknown with Published=true and closes nothing critical; a later
// ReconcileCommitted (after the data fd may already be closed) verifies the
// final entry by pinned inode + digest + size, retries ONLY the durability
// fsync, and returns nil with Published=true.
func TestAttachmentReconcileAfterFsyncFailure(t *testing.T) {
	root := t.TempDir()
	serverID := "c0c0c0c0-1111-4222-8333-444444444444"
	data := []byte("reconcile me")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	fail := true
	restore := setAttachErrHook(func(point string) error {
		if point == "post-rename-fsync" && fail {
			return errors.New("injected fsync failure")
		}
		return nil
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(err, ErrMutationUnknown) || !res.Published {
		t.Fatalf("commit = %v published=%v, want ErrMutationUnknown published=true", err, res.Published)
	}
	if !stage.Committed() {
		t.Fatalf("stage not marked committed after rename")
	}
	// Simulate the daemon having closed the descriptor (e.g. via a Close
	// from a defer path) — ReconcileCommitted must work from saved metadata.
	_ = stage.Close()

	// First reconcile attempt still fails the fsync (hook still on).
	resR, errR := stage.ReconcileCommitted()
	if !errors.Is(errR, ErrMutationUnknown) || !resR.Published {
		t.Fatalf("reconcile with failing fsync = %v published=%v, want ErrMutationUnknown published=true", errR, resR.Published)
	}
	// Output file preserved through the uncertainty.
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("output file not preserved: %q %v", got, rerr)
	}

	// Now let the fsync succeed: reconciliation returns nil.
	fail = false
	resR, errR = stage.ReconcileCommitted()
	restore()
	if errR != nil {
		t.Fatalf("reconcile after fsync recovery: %v", errR)
	}
	if !resR.Published {
		t.Fatalf("reconcile published=false, want true")
	}
	if resR.Rel != serverID+"/attachment.txt" {
		t.Fatalf("reconcile rel = %q", resR.Rel)
	}
	// Idempotent: a second reconciliation returns the same durable result.
	resR2, errR2 := stage.ReconcileCommitted()
	if errR2 != nil || !resR2.Published || resR2.Rel != resR.Rel {
		t.Fatalf("second reconcile = %v %+v, want nil %+v", errR2, resR2, resR)
	}
	// Commit retry after reconciliation still conflicts, never re-publishes.
	resC, errC := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(errC, ErrConflict) {
		t.Fatalf("commit retry after reconcile = %v, want ErrConflict", errC)
	}
	if !resC.Published {
		t.Fatalf("commit retry must carry the reconciled published state")
	}
	// Abort must refuse (committed winner), preserving the published file.
	if err := stage.Abort(); err != ErrConflict {
		t.Fatalf("abort after publish = %v, want ErrConflict", err)
	}
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("published file disturbed: %q %v", got, rerr)
	}
}

// TestAttachmentReconcileDetectsFinalEntryReplacement: if the final entry is
// replaced after the rename, Commit's post-rename verification reports
// unknown_outcome with Published=false (never success), the foreign
// replacement is preserved, and ReconcileCommitted stays fail-closed
// unknown rather than claiming the foreign file.
func TestAttachmentReconcileDetectsFinalEntryReplacement(t *testing.T) {
	root := t.TempDir()
	serverID := "d1d1d1d1-2222-4333-8444-555555555555"
	data := []byte("original published bytes")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	finalFile := committedPathFor(t, root, serverID, "attachment.txt")
	swapped := false
	restore := setAttachHook(func(point, rel string) {
		if point == "post-rename-verify" && !swapped {
			swapped = true
			// Replace the published entry with a foreign file.
			_ = os.Remove(finalFile)
			if err := os.WriteFile(finalFile, []byte("foreign replacement"), 0o600); err != nil {
				t.Errorf("swap: %v", err)
			}
		}
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrMutationUnknown) {
		t.Fatalf("commit with post-rename replacement = %v, want ErrMutationUnknown", err)
	}
	if res.Published {
		t.Fatalf("commit claimed Published despite replacement")
	}
	// Foreign replacement preserved, never deleted.
	if got, rerr := os.ReadFile(finalFile); rerr != nil || string(got) != "foreign replacement" {
		t.Fatalf("foreign replacement disturbed: %q %v", got, rerr)
	}
	// Reconciliation detects the mismatch and stays unknown, fail-closed.
	resR, errR := stage.ReconcileCommitted()
	if !errors.Is(errR, ErrMutationUnknown) {
		t.Fatalf("reconcile after replacement = %v, want ErrMutationUnknown", errR)
	}
	if resR.Published {
		t.Fatalf("reconcile published=true for foreign entry")
	}
	// Still never deleted after reconciliation attempts.
	if got, rerr := os.ReadFile(finalFile); rerr != nil || string(got) != "foreign replacement" {
		t.Fatalf("foreign replacement deleted by reconcile: %q %v", got, rerr)
	}
	// Abort must not remove the foreign data either.
	if err := stage.Abort(); err != ErrConflict {
		t.Fatalf("abort after publish attempt = %v, want ErrConflict", err)
	}
	if got, rerr := os.ReadFile(finalFile); rerr != nil || string(got) != "foreign replacement" {
		t.Fatalf("foreign replacement deleted by abort: %q %v", got, rerr)
	}
}

// TestAttachmentReconcileDetectsFinalEntrySymlink: a symlink swapped onto the
// final entry is detected (not followed), reported unknown, and the symlink
// target is untouched.
func TestAttachmentReconcileDetectsFinalEntrySymlink(t *testing.T) {
	root := t.TempDir()
	serverID := "e2e2e2e2-3333-4444-8555-666666666666"
	data := []byte("symlink case bytes")
	outside := filepath.Join(t.TempDir(), "target.txt")
	if err := os.WriteFile(outside, []byte("target"), 0o600); err != nil {
		t.Fatalf("outside: %v", err)
	}
	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	finalFile := committedPathFor(t, root, serverID, "attachment.txt")
	swapped := false
	restore := setAttachHook(func(point, rel string) {
		if point == "post-rename-verify" && !swapped {
			swapped = true
			_ = os.Remove(finalFile)
			if err := os.Symlink(outside, finalFile); err != nil {
				t.Errorf("symlink: %v", err)
			}
		}
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrMutationUnknown) || res.Published {
		t.Fatalf("commit with symlink swap = %v published=%v, want unknown published=false", err, res.Published)
	}
	if got, rerr := os.ReadFile(outside); rerr != nil || string(got) != "target" {
		t.Fatalf("symlink target disturbed: %q %v", got, rerr)
	}
	resR, errR := stage.ReconcileCommitted()
	if !errors.Is(errR, ErrMutationUnknown) || resR.Published {
		t.Fatalf("reconcile with symlink = %v published=%v, want unknown published=false", errR, resR.Published)
	}
}

// TestAttachmentReconcileDetectsMissingFinalEntry: the final entry vanishing
// (moved away) after the rename is unknown, never success; nothing is
// re-published or fabricated.
func TestAttachmentReconcileDetectsMissingFinalEntry(t *testing.T) {
	root := t.TempDir()
	serverID := "f3f3f3f3-4444-4555-8666-777777777777"
	data := []byte("vanishing bytes")
	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	finalFile := committedPathFor(t, root, serverID, "attachment.txt")
	vanished := false
	restore := setAttachHook(func(point, rel string) {
		if point == "post-rename-verify" && !vanished {
			vanished = true
			_ = os.Remove(finalFile)
		}
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrMutationUnknown) || res.Published {
		t.Fatalf("commit with vanished entry = %v published=%v, want unknown published=false", err, res.Published)
	}
	resR, errR := stage.ReconcileCommitted()
	if !errors.Is(errR, ErrMutationUnknown) || resR.Published {
		t.Fatalf("reconcile with missing entry = %v published=%v, want unknown published=false", errR, resR.Published)
	}
}

// TestAttachmentReconcileRequiresPriorPublish: reconciliation on a stage that
// never published fails closed (conflict), and on a plain successful commit
// is an idempotent durable success.
func TestAttachmentReconcileRequiresPriorPublish(t *testing.T) {
	root := t.TempDir()
	// Never published: conflict, nothing to reconcile.
	stage, res, err := commitUpload(t, root, "a4a4a4a4-5555-4666-8777-888888888888", "text/plain", nil)
	_ = res
	if err != nil {
		t.Fatalf("zero-byte commit: %v", err)
	}
	_ = stage
	// A fresh uncommitted stage reconciles to conflict.
	fresh, err := BeginAttachment(root, "b5b5b5b5-6666-4777-8888-999999999999", "text/plain", 4)
	if err != nil {
		t.Fatalf("begin fresh: %v", err)
	}
	if _, err := fresh.ReconcileCommitted(); err != ErrConflict {
		t.Fatalf("reconcile uncommitted = %v, want ErrConflict", err)
	}
	// A normally successful commit is already durable: reconcile idempotent.
	s2, res2, err2 := commitUpload(t, root, "c6c6c6c6-7777-4888-8999-aaaaaaaaaaaa", "text/plain", []byte("ok"))
	if err2 != nil {
		t.Fatalf("commit: %v", err2)
	}
	if !res2.Published {
		t.Fatalf("commit not published")
	}
	resR, errR := s2.ReconcileCommitted()
	if errR != nil || !resR.Published || resR.Rel != res2.Rel {
		t.Fatalf("reconcile after clean commit = %v %+v, want nil %+v", errR, resR, res2)
	}
}

// TestAttachmentCommitVerifiesMarkerExactName: the staging marker must name
// EXACTLY this stage's data file; a well-formed marker naming a different
// controlled name (e.g. from a different MIME) fails closed before any move.
func TestAttachmentCommitVerifiesMarkerExactName(t *testing.T) {
	root := t.TempDir()
	serverID := "d7d7d7d7-8888-4999-8aaa-bbbbbbbbbbbb"
	data := []byte("marker name check")
	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Rewrite the marker to name a different (still valid) controlled name.
	markerPath := filepath.Join(attachStagePath(t, root, serverID), attachOwnedMark)
	if err := os.WriteFile(markerPath, []byte(attachOwnedMagic+"\nattachment.bin\n"), 0o600); err != nil {
		t.Fatalf("rewrite marker: %v", err)
	}
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(err, ErrChanged) {
		t.Fatalf("commit with mismatched marker name = %v, want ErrChanged", err)
	}
	if res.Published {
		t.Fatalf("published despite marker name mismatch")
	}
	// Nothing at the final path.
	if _, err := os.Stat(committedPathFor(t, root, serverID, "attachment.txt")); !os.IsNotExist(err) {
		t.Fatalf("file published despite marker mismatch (err %v)", err)
	}
}

// TestAttachmentSuccessfulCommitNoStagingLeftover pins the regression where
// stage-parent cleanup used the wrong directory fd: after a fully successful
// commit, this stage's own per-UUID staging dir must be gone. The shared
// .staging base parent may legitimately remain (even empty) because other
// concurrent stages share it — it is never deleted to satisfy a test — so the
// attachments root still lists [.gitignore .staging <finalUUID>]; only this
// stage's own staging UUID must be absent and unrelated directory entries
// must be preserved.
func TestAttachmentSuccessfulCommitNoStagingLeftover(t *testing.T) {
	root := t.TempDir()
	serverID := "e8e8e8e8-9999-4aaa-8bbb-cccccccccccc"
	data := []byte("no leftover staging")
	stage, res, err := commitUpload(t, root, serverID, "text/plain", data)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if !res.Published {
		t.Fatalf("not published")
	}
	_ = stage
	attachments := testBase(t, root)
	entries, rerr := os.ReadDir(attachments)
	if rerr != nil {
		t.Fatalf("read attachments: %v", rerr)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	// The final UUID dir and the control .gitignore must be present; the
	// shared .staging base may remain (even empty) and must be preserved, and
	// no unrelated leftover may appear.
	hasFinal, hasStage := false, false
	for _, n := range names {
		switch n {
		case serverID:
			hasFinal = true
		case ".staging":
			hasStage = true
		default:
			t.Fatalf("unexpected leftover entry %q in attachments", n)
		}
	}
	if !hasFinal {
		t.Fatalf("attachments entries = %v, want final UUID %s present (shared .staging may remain)", names, serverID)
	}
	// This stage's own per-UUID staging dir must be gone, regardless of the
	// shared .staging base being present or empty.
	if _, err := os.Stat(filepath.Join(attachments, ".staging", serverID)); !os.IsNotExist(err) {
		t.Fatalf("staging dir %s left after successful commit (err %v)", serverID, err)
	}
	// The shared .staging base (when present) must not contain this stage's
	// (or any failed) per-UUID dir; it may remain empty or hold other active
	// UUIDs, both of which are preserved.
	if hasStage {
		if stagingEntries, serr := os.ReadDir(filepath.Join(attachments, ".staging")); serr == nil {
			for _, se := range stagingEntries {
				if se.Name() == serverID {
					t.Fatalf(".staging still holds this stage's UUID %s", serverID)
				}
			}
		}
	}
	// And the committed file itself is intact.
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("committed file missing: %q %v", got, rerr)
	}
}

// TestAttachmentConcurrentReconcileSafety: concurrent ReconcileCommitted
// calls on one stage (daemon retry + status path) are safe (no race, no
// double publish) and converge on the durable result.
func TestAttachmentConcurrentReconcileSafety(t *testing.T) {
	root := t.TempDir()
	serverID := "f9f9f9f9-aaaa-4bbb-8ccc-dddddddddddd"
	data := []byte("concurrent reconcile")
	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	fail := true
	restore := setAttachErrHook(func(point string) error {
		if point == "post-rename-fsync" && fail {
			return errors.New("injected")
		}
		return nil
	})
	defer restore()
	if _, err := stage.Commit(int64(len(data)), sha256Of(t, data)); !errors.Is(err, ErrMutationUnknown) {
		t.Fatalf("commit = %v, want ErrMutationUnknown", err)
	}
	fail = false
	var wg sync.WaitGroup
	results := make([]AttachCommitResult, 4)
	errs := make([]error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = stage.ReconcileCommitted()
		}(i)
	}
	wg.Wait()
	restore()
	for i := range errs {
		if errs[i] != nil {
			t.Fatalf("concurrent reconcile %d: %v", i, errs[i])
		}
		if !results[i].Published || results[i].Rel != serverID+"/attachment.txt" {
			t.Fatalf("concurrent reconcile %d = %+v, want published", i, results[i])
		}
	}
}

// TestAttachmentReconcileSuccessCleansStagingAndClosesFD covers the bounded
// finish handoff: an fsync-uncertain Commit retains the data-file descriptor
// and this stage's own staging marker/UUID dir; a successful reconciliation
// closes the retained descriptor and removes exactly this stage's own staging
// UUID (never the shared .staging parent, never completed files). No syscall
// is issued through the stale data descriptor afterwards.
func TestAttachmentReconcileSuccessCleansStagingAndClosesFD(t *testing.T) {
	root := t.TempDir()
	serverID := "d0d0d0d0-1111-4222-8333-444444444444"
	data := []byte("reconcile cleanup")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	fail := true
	restore := setAttachErrHook(func(point string) error {
		if point == "post-rename-fsync" && fail {
			return errors.New("injected fsync failure")
		}
		return nil
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(err, ErrMutationUnknown) || !res.Published {
		t.Fatalf("commit = %v published=%v, want ErrMutationUnknown published=true", err, res.Published)
	}
	// While the outcome is uncertain the descriptor and staging leftovers
	// must still be retained/reconcilable (cleanup happens only on confirmed
	// durability).
	staging := attachStagePath(t, root, serverID)
	if stage.file == nil {
		t.Fatalf("data descriptor released before durable reconcile")
	}
	if _, serr := os.Stat(filepath.Join(staging, attachOwnedMark)); serr != nil {
		t.Fatalf("staging marker not retained before durable reconcile (err %v)", serr)
	}

	// Now reconciliation succeeds: it must close the retained descriptor,
	// mark closed, and remove this stage's own staging UUID.
	fail = false
	resR, errR := stage.ReconcileCommitted()
	restore()
	if errR != nil || !resR.Published {
		t.Fatalf("reconcile = %v %+v, want nil published=true", errR, resR)
	}
	if stage.file != nil {
		t.Fatalf("data descriptor not closed after durable reconcile")
	}
	if !stage.closed || !stage.durable {
		t.Fatalf("stage not closed/durable after reconcile (closed=%v durable=%v)", stage.closed, stage.durable)
	}
	// Own staging UUID dir gone; completed file preserved; shared .staging
	// base (if present) preserved.
	if _, serr := os.Stat(staging); !os.IsNotExist(serr) {
		t.Fatalf("own staging UUID dir left after durable reconcile (err %v)", serr)
	}
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("completed file disturbed after reconcile: %q %v", got, rerr)
	}
	// No syscall through a stale descriptor: the stage can no longer be
	// written (conflict) nor aborted, and Close is a no-op — none of these
	// touch a closed FD.
	if err := stage.WriteAt(int64(len(data)), []byte("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("write after durable reconcile = %v, want ErrNotFound (descriptor released)", err)
	}
	if err := stage.Abort(); !errors.Is(err, ErrConflict) {
		t.Fatalf("abort after durable reconcile = %v, want ErrConflict", err)
	}
	if err := stage.Close(); err != nil {
		t.Fatalf("close after durable reconcile = %v, want nil", err)
	}
}

// TestAttachmentVerifyPublishedFDNoDoubleClose is a regression for an FD
// ownership bug in verifyPublished: it wrapped the raw unix.Openat descriptor
// in an *os.File (which arms a close finalizer) while ALSO raw-closing the same
// descriptor. That left a stale, finalizer-armed wrapper whose finalizer could
// later close a REUSED descriptor number owned by a different
// upload/socket. This test drives Commit -> fsync-unknown -> Reconcile success
// (both call verifyPublished), then with autogc disabled opens sentinel
// descriptors that reuse the freed low fd numbers, forces collection, and
// asserts every sentinel descriptor is still valid. GC is disabled globally so
// the stale wrapper is guaranteed to still be uncollected at sentinel-open
// time, then forced with explicit runtime.GC; it is restored via Cleanup and
// the test is never parallelized (it must not race other GC state).
func TestAttachmentVerifyPublishedFDNoDoubleClose(t *testing.T) {
	oldGC := debug.SetGCPercent(-1)
	t.Cleanup(func() { debug.SetGCPercent(oldGC) })

	root := t.TempDir()
	serverID := "a6a6a6a6-1111-4222-8333-444444444444"
	data := []byte("fd ownership regression")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	fail := true
	restore := setAttachErrHook(func(point string) error {
		if point == "post-rename-fsync" && fail {
			return errors.New("injected")
		}
		return nil
	})
	defer restore()
	if res, err := stage.Commit(int64(len(data)), sha256Of(t, data)); !errors.Is(err, ErrMutationUnknown) || !res.Published {
		t.Fatalf("commit = %v %+v, want ErrMutationUnknown published=true", err, res)
	}
	fail = false
	if resR, errR := stage.ReconcileCommitted(); errR != nil || !resR.Published {
		t.Fatalf("reconcile = %v %+v, want nil published=true", errR, resR)
	}
	restore()

	// Open sentinel descriptors that reuse the low fd numbers freed when
	// verifyPublished closed its finalizer-armed wrapper.
	sentinels := make([]*os.File, 0, 16)
	defer func() {
		for _, f := range sentinels {
			_ = f.Close()
		}
	}()
	for i := 0; i < 16; i++ {
		f, err := os.OpenFile(filepath.Join(t.TempDir(), "sent"), os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			t.Fatalf("open sentinel %d: %v", i, err)
		}
		if _, err := f.Write([]byte("sentinel")); err != nil {
			_ = f.Close()
			t.Fatalf("initial write sentinel %d: %v", i, err)
		}
		sentinels = append(sentinels, f)
	}

	// Force collection. Under the buggy double-close/ownership code the stale
	// wrapper's finalizer would close one of the reused sentinel descriptors,
	// making the following writes fail with EBADF.
	runtime.GC()
	runtime.GC()
	for i, f := range sentinels {
		if _, err := f.Write([]byte("x")); err != nil {
			t.Fatalf("sentinel %d descriptor invalidated by stale finalizer (fd double-close/reuse): %v", i, err)
		}
	}
}

// TestAttachmentRenameEIOAfterRealRenameUnknownThenReconcile covers the
// uncertain-rename gap: the real rename succeeds but the syscall result is
// reported as EIO. Commit must return unknown with the publication barrier
// RAISED (Committed() true) so a Cancel/Abort can never report the upload as
// cancelled and no second file is blind-published; reconciliation then verifies
// the actually-published inode and reports committed, and the bytes survive.
func TestAttachmentRenameEIOAfterRealRenameUnknownThenReconcile(t *testing.T) {
	root := t.TempDir()
	serverID := "a7a7a7a7-1111-4222-8333-444444444444"
	data := []byte("uncertain rename outcome")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Seam: perform the REAL rename, then report an injected EIO so the caller
	// sees an uncertain outcome although the file actually moved.
	restore := setAttachRenameSeam(func(od int, on string, nd int, nn string) error {
		if err := unixRenameNoReplace(od, on, nd, nn); err != nil {
			return err
		}
		return unix.EIO
	})
	defer restore()

	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrMutationUnknown) {
		t.Fatalf("commit = %v, want ErrMutationUnknown", err)
	}
	if res.Published {
		t.Fatalf("commit claimed Published on uncertain rename")
	}
	// Publication barrier raised: never cancellable, never re-published.
	if !stage.Committed() {
		t.Fatalf("stage not publication-barriered after uncertain rename")
	}
	if err := stage.Abort(); !errors.Is(err, ErrConflict) {
		t.Fatalf("abort after uncertain rename = %v, want ErrConflict", err)
	}
	// The real rename moved the bytes; they must be preserved at the final path.
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("bytes not preserved: %q %v", got, rerr)
	}
	// Reconciliation verifies the committed final inode and reports published.
	resR, errR := stage.ReconcileCommitted()
	if errR != nil || !resR.Published {
		t.Fatalf("reconcile = %v %+v, want nil published=true", errR, resR)
	}
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("bytes disturbed after reconcile: %q %v", got, rerr)
	}
}

// TestAttachmentRenameEIOWithoutRenameNoFalseCancel covers the other uncertain
// side: EIO with NO rename (nothing moved). Commit still raises the publication
// barrier (the outcome is explicitly unknown — the daemon must not report the
// upload as cancelled), never re-publishes on retry, never fabricates success,
// and the retained handle's Close is safe (files/descriptors are released, not
// corrupted).
func TestAttachmentRenameEIOWithoutRenameNoFalseCancel(t *testing.T) {
	root := t.TempDir()
	serverID := "b8b8b8b8-2222-4333-8444-555555555555"
	data := []byte("no rename actually happened")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	// Seam: EIO with NO real rename — the publish definitely did not move anything.
	restore := setAttachRenameSeam(func(od int, on string, nd int, nn string) error {
		return unix.EIO
	})
	defer restore()

	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrMutationUnknown) || res.Published {
		t.Fatalf("commit = %v %+v, want ErrMutationUnknown unpublished", err, res)
	}
	if !stage.Committed() {
		t.Fatalf("stage not publication-barriered on uncertain EIO without rename")
	}
	if err := stage.Abort(); !errors.Is(err, ErrConflict) {
		t.Fatalf("abort = %v, want ErrConflict (never report cancelled while uncertain)", err)
	}
	// Nothing was actually published; remain unknown, never fabricate success.
	resR, errR := stage.ReconcileCommitted()
	if !errors.Is(errR, ErrMutationUnknown) || resR.Published {
		t.Fatalf("reconcile with no final entry = %v %+v, want unknown published=false", errR, resR)
	}
	if _, serr := os.Stat(committedPathFor(t, root, serverID, "attachment.txt")); !os.IsNotExist(serr) {
		t.Fatalf("file published despite EIO-without-rename (err %v)", serr)
	}
	// Never retry publish: a Commit retry must conflict (delegate, no rename)
	// rather than blind-publish a second file.
	resC, errC := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(errC, ErrConflict) || resC.Published {
		t.Fatalf("commit retry = %v %+v, want ErrConflict unpublished (never re-publish)", errC, resC)
	}
	if _, serr := os.Stat(committedPathFor(t, root, serverID, "attachment.txt")); !os.IsNotExist(serr) {
		t.Fatalf("file appeared after commit retry (err %v)", serr)
	}
	// Retained handle Close is safe (releases the descriptor; reserved files are
	// preserved for later lazy cleanup).
	if err := stage.Close(); err != nil {
		t.Fatalf("close retained handle = %v, want nil", err)
	}
	if stage.file != nil {
		t.Fatalf("descriptor not released after Close")
	}
}

// TestAttachmentRootFsyncFailureUncertainThenReconcile is the F1.1 regression:
// fsyncPublishChain now fsyncs the root too (so a freshly created .pairfob
// entry is durable). A failure at that final root fsync must surface as
// published-unknown (ErrMutationUnknown) with the bytes preserved, and a later
// ReconcileCommitted retries the chain and reports committed.
func TestAttachmentRootFsyncFailureUncertainThenReconcile(t *testing.T) {
	root := t.TempDir()
	serverID := "c9c9c9c9-3333-4444-8555-666666666666"
	data := []byte("root fsync chain durability")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	fail := true
	restore := setAttachErrHook(func(point string) error {
		if point == "pre-root-fsync" && fail {
			return errors.New("injected root fsync failure")
		}
		return nil
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(err, ErrMutationUnknown) || !res.Published {
		t.Fatalf("commit = %v %+v, want ErrMutationUnknown published=true", err, res)
	}
	// Bytes preserved despite the uncertain durability.
	if got, rerr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); rerr != nil || !bytes.Equal(got, data) {
		t.Fatalf("bytes not preserved on root-fsync failure: %q %v", got, rerr)
	}
	// Reconciliation retries the chain (now including the root fsync) and
	// reports committed.
	fail = false
	resR, errR := stage.ReconcileCommitted()
	restore()
	if errR != nil || !resR.Published {
		t.Fatalf("reconcile after root-fsync recovery = %v %+v, want nil published=true", errR, resR)
	}
}
