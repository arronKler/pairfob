//go:build unix

// Focused hardening tests for attachment storage: inode pinning against
// replacement/symlink swaps, fail-closed bounded quota scan, serialized
// quota+publish, marker validation and exact owned cleanup, and the
// attachment-local .gitignore contract (D7/D13/D15).
package workspace

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func attachStagePath(t *testing.T, root, serverID string) string {
	t.Helper()
	return filepath.Join(testBase(t, root), attachStageRel, serverID)
}

func committedPathFor(t *testing.T, root, serverID, dataName string) string {
	t.Helper()
	return filepath.Join(testBase(t, root), serverID, dataName)
}

// TestAttachmentCommitRejectsStagedDataReplacement: after hashing, replacing
// the staged data name with a different file (same name, new inode) must fail
// closed with ErrChanged and publish nothing — the pinned inode identity, not
// the pathname, is authoritative.
func TestAttachmentCommitRejectsStagedDataReplacement(t *testing.T) {
	root := t.TempDir()
	serverID := "01010101-0202-4030-8040-050505050505"
	data := []byte("verified staged bytes")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	hookDone := false
	restore := setAttachHook(func(stageName, rel string) {
		if stageName == "pre-rename" && !hookDone {
			hookDone = true
			staging := attachStagePath(t, root, serverID)
			target := filepath.Join(staging, "attachment.txt")
			_ = os.Remove(target)
			if err := os.WriteFile(target, []byte("swapped bytes"), 0o600); err != nil {
				t.Fatalf("swap: %v", err)
			}
		}
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrChanged) {
		t.Fatalf("commit after data replacement = %v, want ErrChanged", err)
	}
	if res.Published {
		t.Fatalf("published despite data replacement")
	}
	if _, err := os.Stat(committedPathFor(t, root, serverID, "attachment.txt")); !os.IsNotExist(err) {
		t.Fatalf("file published after replacement (err %v)", err)
	}
}

// TestAttachmentCommitRejectsStagedDataSymlink: replacing the staged data
// name with a symlink must fail closed before the rename, never publish the
// symlink target's content.
func TestAttachmentCommitRejectsStagedDataSymlink(t *testing.T) {
	root := t.TempDir()
	serverID := "03030303-0404-4050-8060-070707070707"
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret target"), 0o600); err != nil {
		t.Fatalf("outside: %v", err)
	}
	data := []byte("staged truth")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	hookDone := false
	restore := setAttachHook(func(stageName, rel string) {
		if stageName == "pre-rename" && !hookDone {
			hookDone = true
			target := filepath.Join(attachStagePath(t, root, serverID), "attachment.txt")
			_ = os.Remove(target)
			if err := os.Symlink(outside, target); err != nil {
				t.Fatalf("symlink: %v", err)
			}
		}
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrChanged) {
		t.Fatalf("commit after symlink swap = %v, want ErrChanged", err)
	}
	if res.Published {
		t.Fatalf("published despite symlink swap")
	}
	if _, err := os.Stat(committedPathFor(t, root, serverID, "attachment.txt")); !os.IsNotExist(err) {
		t.Fatalf("file published after symlink swap (err %v)", err)
	}
	if got, err := os.ReadFile(outside); err != nil || !bytes.Equal(got, []byte("secret target")) {
		t.Fatalf("symlink target disturbed: %q %v", got, err)
	}
}

// TestAttachmentCommitRejectsStagingDirSwap: replacing the whole staging
// directory (new inode) between hash and publish must fail closed.
func TestAttachmentCommitRejectsStagingDirSwap(t *testing.T) {
	root := t.TempDir()
	serverID := "05050505-0606-4070-8080-090909090909"
	data := []byte("pinned staging bytes")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	hookDone := false
	restore := setAttachHook(func(stageName, rel string) {
		if stageName == "pre-rename" && !hookDone {
			hookDone = true
			staging := attachStagePath(t, root, serverID)
			_ = os.RemoveAll(staging)
			if err := os.MkdirAll(staging, 0o700); err != nil {
				t.Fatalf("recreate staging: %v", err)
			}
			if err := os.WriteFile(filepath.Join(staging, "attachment.txt"), data, 0o600); err != nil {
				t.Fatalf("recreate data: %v", err)
			}
		}
	})
	defer restore()
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrChanged) {
		t.Fatalf("commit after staging dir swap = %v, want ErrChanged", err)
	}
	if res.Published {
		t.Fatalf("published despite staging dir swap")
	}
}

// TestAttachmentAbortRejectsStagingDirSwap: abort must also verify the pinned
// staging identity before removing anything.
func TestAttachmentAbortRejectsStagingDirSwap(t *testing.T) {
	root := t.TempDir()
	serverID := "0a0a0a0a-0b0b-40c0-80d0-0e0e0e0e0e0e"

	stage, err := BeginAttachment(root, serverID, "text/plain", 32)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	staging := attachStagePath(t, root, serverID)
	// Replace the staging dir contents and the dir itself with attacker data.
	if err := os.WriteFile(filepath.Join(staging, "innocent.txt"), []byte("keep me"), 0o600); err != nil {
		t.Fatalf("plant: %v", err)
	}
	_ = stage.Close() // close so we can rebuild the dir
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staging, "innocent.txt"), []byte("keep me"), 0o600); err != nil {
		t.Fatalf("plant: %v", err)
	}
	if err := stage.Abort(); !errors.Is(err, ErrChanged) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("abort after staging swap = %v, want ErrChanged or ErrNotFound", err)
	}
	if got, err := os.ReadFile(filepath.Join(staging, "innocent.txt")); err != nil || !bytes.Equal(got, []byte("keep me")) {
		t.Fatalf("unrelated file removed by abort: %q %v", got, err)
	}
}

// TestAttachmentPostRenameFailureNeverRepublishes: a failure after the
// successful rename (directory fsync) must surface ErrMutationUnknown with
// Published=true and the committed file present, and a retry Commit must
// conflict instead of blind-publishing a second time.
func TestAttachmentPostRenameFailureNeverRepublishes(t *testing.T) {
	root := t.TempDir()
	serverID := "0f0f0f0f-1010-4111-8121-131313131313"
	data := []byte("bytes that reached the final path")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	restore := setAttachErrHook(func(point string) error {
		if point == "post-rename-fsync" {
			return fmt.Errorf("injected fsync failure")
		}
		return nil
	})
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	restore()
	if !errors.Is(err, ErrMutationUnknown) {
		t.Fatalf("commit with injected post-rename failure = %v, want ErrMutationUnknown", err)
	}
	if !res.Published {
		t.Fatalf("unknown outcome must carry Published=true for reconciliation")
	}
	got, readErr := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt"))
	if readErr != nil || !bytes.Equal(got, data) {
		t.Fatalf("committed file missing after unknown outcome: %q %v", got, readErr)
	}
	// Retry must conflict (reconcile via status), never publish again.
	res2, err2 := stage.Commit(int64(len(data)), sha256Of(t, data))
	if !errors.Is(err2, ErrConflict) {
		t.Fatalf("retry commit after unknown outcome = %v, want ErrConflict", err2)
	}
	if !res2.Published {
		t.Fatalf("retry must report Published=true with the reconcilable result")
	}
	if err := stage.Abort(); err != ErrConflict {
		t.Fatalf("abort after publish = %v, want ErrConflict", err)
	}
	if got, err := os.ReadFile(committedPathFor(t, root, serverID, "attachment.txt")); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("committed file disturbed after unknown outcome: %q %v", got, err)
	}
}

// TestAttachmentQuotaScanFailsClosedOnErrors: unreadable directories or stat
// failures during the completed-bytes scan abort with an error, never a
// silently small total.
func TestAttachmentQuotaScanFailsClosedOnErrors(t *testing.T) {
	root := t.TempDir()
	base := testBase(t, root)
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatalf("base: %v", err)
	}
	// A subdirectory the current user cannot open (stat itself still works;
	// the open of the dir for reading entries fails).
	blocked := filepath.Join(base, "11111111-2222-4333-8444-555555555555")
	if err := os.MkdirAll(blocked, 0o000); err != nil {
		t.Fatalf("blocked: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o700) })
	if _, err := AttachCompletedBytes(root); err == nil {
		t.Fatalf("quota scan ignored unreadable directory (want error)")
	}
	// Restoring permissions makes the scan work again.
	if err := os.Chmod(blocked, 0o700); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if _, err := AttachCompletedBytes(root); err != nil {
		t.Fatalf("quota scan after restore: %v", err)
	}
}

// TestAttachmentQuotaCountsEntriesAndSkipsStaging: completed bytes count only
// the final tree (never .staging, never symlinks), paginated and bounded; a
// too-deep tree fails closed with ErrTooLarge rather than undercounting.
func TestAttachmentQuotaCountsEntriesAndSkipsStaging(t *testing.T) {
	root := t.TempDir()
	base := testBase(t, root)
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatalf("base: %v", err)
	}
	one := filepath.Join(base, "22222222-3333-4444-8555-666666666666")
	if err := os.MkdirAll(one, 0o700); err != nil {
		t.Fatalf("one: %v", err)
	}
	if err := os.WriteFile(filepath.Join(one, "attachment.txt"), []byte("12345"), 0o600); err != nil {
		t.Fatalf("data: %v", err)
	}
	// Staging content must NOT count toward completed bytes.
	stageDir := filepath.Join(base, ".staging", "99999999-8888-4777-8666-555555555555")
	if err := os.MkdirAll(stageDir, 0o700); err != nil {
		t.Fatalf("staging: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stageDir, "attachment.bin"), bytes.Repeat([]byte("x"), 100), 0o600); err != nil {
		t.Fatalf("staged: %v", err)
	}
	// A symlink in the final tree is not followed and not counted.
	if err := os.Symlink(one, filepath.Join(base, "linked-dir")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	got, err := AttachCompletedBytes(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	// attachment.txt (5) only.
	if got != 5 {
		t.Fatalf("completed bytes = %d, want 5", got)
	}

	// Entry-cap enforcement: lowering the cap below the real entry count
	// must fail the scan closed (ErrTooLarge), not undercount.
	restore := setAttachScanEntryLimit(1)
	defer restore()
	if _, err := AttachCompletedBytes(root); err != ErrTooLarge {
		t.Fatalf("scan with entry cap = %v, want ErrTooLarge", err)
	}
	restore()
}

// setAttachScanEntryLimit lowers the quota scan entry cap for a test.
func setAttachScanEntryLimit(limit int) func() {
	prev := attachScanEntryLimit
	attachScanEntryLimit = limit
	return func() { attachScanEntryLimit = prev }
}

// setAttachCompletedLimit lowers the completed-storage quota for a test.
func setAttachCompletedLimit(limit int64) func() {
	prev := attachCompletedLimit
	attachCompletedLimit = limit
	return func() { attachCompletedLimit = prev }
}

// TestAttachmentQuotaRejectsCommitOverLimit: with a small injected quota, a
// commit that would exceed it fails with ErrTooLarge and publishes nothing;
// an existing committed file stays and a later, smaller commit still works.
func TestAttachmentQuotaRejectsCommitOverLimit(t *testing.T) {
	root := t.TempDir()
	restore := setAttachCompletedLimit(10)
	defer restore()

	commit := func(id, body string) error {
		stage, err := BeginAttachment(root, id, "text/plain", int64(len(body)))
		if err != nil {
			t.Fatalf("begin %s: %v", id, err)
		}
		defer stage.Close()
		if err := stage.WriteAt(0, []byte(body)); err != nil {
			t.Fatalf("write %s: %v", id, err)
		}
		_, err = stage.Commit(int64(len(body)), sha256Of(t, []byte(body)))
		return err
	}
	if err := commit("12345678-1234-4123-8123-123456789abc", "1234567"); err != nil {
		t.Fatalf("first small commit: %v", err)
	}
	// 7 of 10 in use; 4 more would exceed it.
	if err := commit("12345678-1234-4123-8123-123456789abd", "abcd"); err != ErrTooLarge {
		t.Fatalf("over-quota commit = %v, want ErrTooLarge", err)
	}
	if _, err := os.Stat(committedPathFor(t, root, "12345678-1234-4123-8123-123456789abd", "attachment.txt")); !os.IsNotExist(err) {
		t.Fatalf("over-quota commit published a file (err %v)", err)
	}
	// Existing committed file untouched.
	if got, err := os.ReadFile(committedPathFor(t, root, "12345678-1234-4123-8123-123456789abc", "attachment.txt")); err != nil || string(got) != "1234567" {
		t.Fatalf("existing committed file disturbed: %q %v", got, err)
	}
}

// TestAttachmentQuotaSerializedConcurrentCommits: two concurrent commits near
// a small quota limit cannot together exceed it — quota check + publish are
// serialized, so exactly one wins and the other fails ErrTooLarge.
func TestAttachmentQuotaSerializedConcurrentCommits(t *testing.T) {
	root := t.TempDir()
	restore := setAttachCompletedLimit(7)
	defer restore()

	commit := func(id string, body []byte) error {
		stage, err := BeginAttachment(root, id, "text/plain", int64(len(body)))
		if err != nil {
			return err
		}
		defer stage.Close()
		if err := stage.WriteAt(0, body); err != nil {
			return err
		}
		_, err = stage.Commit(int64(len(body)), sha256Of(t, body))
		return err
	}
	bodyA := []byte("12345") // 5 bytes
	bodyB := []byte("678")   // 3 bytes; together 8 > 7 available
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, spec := range []struct {
		id   string
		body []byte
	}{{"abcdefab-cdef-4acd-8acd-abcdefabcdef", bodyA}, {"abcdefab-cdef-4acd-8acd-abcdefabcdaa", bodyB}} {
		wg.Add(1)
		go func(i int, id string, body []byte) {
			defer wg.Done()
			errs[i] = commit(id, body)
		}(i, spec.id, spec.body)
	}
	wg.Wait()
	// At most one commit succeeded; the other (if attempted second) saw the
	// first's bytes and failed ErrTooLarge.
	successes := 0
	for _, err := range errs {
		if err == nil {
			successes++
		} else if err != ErrTooLarge {
			t.Fatalf("concurrent commit error = %v, want nil or ErrTooLarge", err)
		}
	}
	if successes > 1 {
		t.Fatalf("both concurrent commits published (%v), quota not serialized", errs)
	}
	used, err := AttachCompletedBytes(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if used > 7 {
		t.Fatalf("quota exceeded: used %d > 7", used)
	}
}

// TestAttachmentCleanupValidatesMarker: lazy cleanup removes only staging
// dirs whose .owned marker validates (magic/version + expected controlled
// data name); malformed markers, non-UUID dirs, and committed files are never
// touched, and unrelated files inside a valid staging dir block its removal.
func TestAttachmentCleanupValidatesMarker(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(testBase(t, root), attachStageRel)
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatalf("staging base: %v", err)
	}
	// 1. Valid owned staging dir, old: fully removed.
	goodID := "23456789-2345-4234-8234-23456789abcd"
	good := filepath.Join(base, goodID)
	if err := os.MkdirAll(good, 0o700); err != nil {
		t.Fatalf("good: %v", err)
	}
	if err := os.WriteFile(filepath.Join(good, "attachment.txt"), []byte("stale"), 0o600); err != nil {
		t.Fatalf("good data: %v", err)
	}
	if err := os.WriteFile(filepath.Join(good, attachOwnedMark), []byte(attachOwnedMagic+"\nattachment.txt\n"), 0o600); err != nil {
		t.Fatalf("good marker: %v", err)
	}
	timeOldMarker(t, good)

	// 2. Malformed marker (wrong magic): dir must survive untouched.
	badMagicID := "3456789a-3456-4345-8345-3456789abcda"
	badMagic := filepath.Join(base, badMagicID)
	if err := os.MkdirAll(badMagic, 0o700); err != nil {
		t.Fatalf("bad magic: %v", err)
	}
	if err := os.WriteFile(filepath.Join(badMagic, "attachment.bin"), []byte("x"), 0o600); err != nil {
		t.Fatalf("bad magic data: %v", err)
	}
	if err := os.WriteFile(filepath.Join(badMagic, attachOwnedMark), []byte("not-pairfob\nattachment.bin\n"), 0o600); err != nil {
		t.Fatalf("bad magic marker: %v", err)
	}
	timeOldMarker(t, badMagic)

	// 3. Marker naming an unexpected file: marker invalid, dir survives.
	wrongNameID := "456789ab-4567-4456-8456-456789abcdaa"
	wrongName := filepath.Join(base, wrongNameID)
	if err := os.MkdirAll(wrongName, 0o700); err != nil {
		t.Fatalf("wrong name: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wrongName, "attachment.txt"), []byte("y"), 0o600); err != nil {
		t.Fatalf("wrong name data: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wrongName, attachOwnedMark), []byte(attachOwnedMagic+"\nwhatever.exe\n"), 0o600); err != nil {
		t.Fatalf("wrong name marker: %v", err)
	}
	timeOldMarker(t, wrongName)

	// 4. Non-UUID directory with a perfectly valid marker: never touched.
	foreign := filepath.Join(base, "not-a-uuid")
	if err := os.MkdirAll(foreign, 0o700); err != nil {
		t.Fatalf("foreign: %v", err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "attachment.txt"), []byte("z"), 0o600); err != nil {
		t.Fatalf("foreign data: %v", err)
	}
	if err := os.WriteFile(filepath.Join(foreign, attachOwnedMark), []byte(attachOwnedMagic+"\nattachment.txt\n"), 0o600); err != nil {
		t.Fatalf("foreign marker: %v", err)
	}
	timeOldMarker(t, foreign)

	// 5. Valid marker but an unrelated extra file: marker+data removed, dir
	// kept (rmdir fails), unrelated file preserved.
	extraID := "56789abc-5678-4567-8567-56789abcdaab"
	extra := filepath.Join(base, extraID)
	if err := os.MkdirAll(extra, 0o700); err != nil {
		t.Fatalf("extra: %v", err)
	}
	if err := os.WriteFile(filepath.Join(extra, "attachment.txt"), []byte("d"), 0o600); err != nil {
		t.Fatalf("extra data: %v", err)
	}
	if err := os.WriteFile(filepath.Join(extra, attachOwnedMark), []byte(attachOwnedMagic+"\nattachment.txt\n"), 0o600); err != nil {
		t.Fatalf("extra marker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(extra, "userfile.txt"), []byte("precious"), 0o600); err != nil {
		t.Fatalf("extra userfile: %v", err)
	}
	timeOldMarker(t, extra)

	removed, err := AttachCleanupExpired(root, 3600, nil)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed %d staging dirs, want exactly 1 (the fully owned one)", removed)
	}
	if _, err := os.Stat(good); !os.IsNotExist(err) {
		t.Fatalf("owned stale dir not removed (err %v)", err)
	}
	for _, dir := range []string{badMagic, wrongName, foreign, extra} {
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("dir %s disturbed by cleanup: %v", dir, err)
		}
	}
	if got, err := os.ReadFile(filepath.Join(extra, "userfile.txt")); err != nil || string(got) != "precious" {
		t.Fatalf("unrelated file removed by cleanup: %q %v", got, err)
	}
	// Owned data/marker in the extra dir were removed; only userfile remains.
	if _, err := os.Stat(filepath.Join(extra, "attachment.txt")); !os.IsNotExist(err) {
		t.Fatalf("owned data file not removed from extra dir (err %v)", err)
	}
}

// timeOldMarker backdates a directory's mtime beyond the cleanup age so
// AttachCleanupExpired considers it stale.
func timeOldMarker(t *testing.T, dir string) {
	t.Helper()
	past := time.Now().Add(-72 * time.Hour)
	if err := os.Chtimes(dir, past, past); err != nil {
		t.Fatalf("chtimes %s: %v", dir, err)
	}
}

// TestAttachmentCleanupSkipsActiveAndFresh: active staging IDs are never
// touched even when old; fresh owned dirs stay because they are not yet
// expired.
func TestAttachmentCleanupSkipsActiveAndFresh(t *testing.T) {
	root := t.TempDir()
	activeID := "6789abcd-678a-4678-8678-6789abcdabcd"
	stage, err := BeginAttachment(root, activeID, "text/plain", 8)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	staging := attachStagePath(t, root, activeID)
	timeOldMarker(t, staging)

	removed, err := AttachCleanupExpired(root, 3600, []string{activeID})
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed %d, want 0 (active stage must be skipped)", removed)
	}
	if _, err := os.Stat(staging); err != nil {
		t.Fatalf("active staging dir removed: %v", err)
	}
	// Fresh dirs (recent mtime) are never eligible.
	freshID := "789abcde-789b-4789-8789-789abcdebcde"
	stage2, err := BeginAttachment(root, freshID, "text/plain", 8)
	if err != nil {
		t.Fatalf("begin fresh: %v", err)
	}
	defer stage2.Close()
	// The old active stage stays active-listed; the fresh one is protected
	// by its recent mtime alone.
	removed, err = AttachCleanupExpired(root, 3600, []string{activeID})
	if err != nil {
		t.Fatalf("cleanup fresh: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed %d, want 0 (fresh stage must be skipped)", removed)
	}
}

// TestAttachmentCleanupNeverTouchesCommitted: completed files live outside
// .staging and are never candidates for cleanup, even when old.
func TestAttachmentCleanupNeverTouchesCommitted(t *testing.T) {
	root := t.TempDir()
	serverID := "89abcdef-89ac-489a-889a-89abcdefcdef"
	data := []byte("committed survives cleanup")
	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := stage.Commit(int64(len(data)), sha256Of(t, data)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	final := committedPathFor(t, root, serverID, "attachment.txt")
	timeOldMarker(t, filepath.Dir(final))
	timeOldMarker(t, root)

	removed, err := AttachCleanupExpired(root, 0, nil)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed %d, want 0 (nothing staged to remove)", removed)
	}
	if got, err := os.ReadFile(final); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("committed file removed by cleanup: %q %v", got, err)
	}
}

// TestAttachmentMarkerFormatBounds: the owned marker is bounded — oversized,
// missing, directory-typed or garbage markers all invalidate ownership.
func TestAttachmentMarkerFormatBounds(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(testBase(t, root), attachStageRel)
	cases := []struct {
		name   string
		marker []byte
	}{
		{"empty", nil},
		{"garbage", []byte("garbage")},
		{"no-data-name", []byte(attachOwnedMagic + "\n")},
		{"too-many-lines", []byte(attachOwnedMagic + "\nattachment.txt\nextra\n")},
		{"oversized", append([]byte(attachOwnedMagic+"\n"), bytes.Repeat([]byte("a"), 256)...)},
		{"dot-name", []byte(attachOwnedMagic + "\n.hidden\n")},
		{"traversal-name", []byte(attachOwnedMagic + "\n../escape.txt\n")},
		{"slash-name", []byte(attachOwnedMagic + "\na/b.txt\n")},
	}
	for i, tc := range cases {
		id := fmt.Sprintf("aaaaaaa%01d-aaaa-4aaa-8aaa-aaaaaaaaaaaa", i)
		dir := filepath.Join(base, id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		markerPath := filepath.Join(dir, attachOwnedMark)
		if tc.marker == nil {
			// no marker file at all
		} else if err := os.WriteFile(markerPath, tc.marker, 0o600); err != nil {
			t.Fatalf("%s marker: %v", tc.name, err)
		}
		timeOldMarker(t, dir)
	}
	removed, err := AttachCleanupExpired(root, 0, nil)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed %d dirs with malformed markers, want 0", removed)
	}
	// A directory-typed marker is also invalid.
	dirID := "aaaaaaab-aaaa-4aaa-8aaa-aaaaaaaaaaab"
	if err := os.MkdirAll(filepath.Join(base, dirID, attachOwnedMark), 0o700); err != nil {
		t.Fatalf("dir marker: %v", err)
	}
	timeOldMarker(t, filepath.Join(base, dirID))
	removed, err = AttachCleanupExpired(root, 0, nil)
	if err != nil {
		t.Fatalf("cleanup dir marker: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed %d, want 0 (directory-typed marker invalid)", removed)
	}
}

// TestAttachmentCommittedFlag: Committed() reflects the publish state across
// the lifecycle.
func TestAttachmentCommittedFlag(t *testing.T) {
	root := t.TempDir()
	serverID := "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
	data := []byte("flag check")
	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if stage.Committed() {
		t.Fatalf("fresh stage reports committed")
	}
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := stage.Commit(int64(len(data)), sha256Of(t, data)); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if !stage.Committed() {
		t.Fatalf("committed stage does not report committed")
	}
}
