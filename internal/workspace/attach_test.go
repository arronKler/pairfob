//go:build unix

// Focused tests for the attachment storage stage: Begin -> WriteAt -> Commit
// publishes the exact bytes with the verified digest, unknown valid MIME falls
// back to attachment.bin, zero-byte commits work, and a committed file is
// never removed by a later cancel.
package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func sha256Of(t *testing.T, data []byte) string {
	t.Helper()
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// testBase returns the attachment base of a pane root.
func testBase(t *testing.T, root string) string {
	t.Helper()
	base, err := AttachBase(root)
	if err != nil {
		t.Fatalf("attach base: %v", err)
	}
	return base
}

func finalPathFor(t *testing.T, root, rel string) string {
	t.Helper()
	return filepath.Join(testBase(t, root), filepath.FromSlash(rel))
}

// TestAttachmentTextBeginWriteCommit covers the measured EBADF regression:
// Begin opens the data file for writing, Commit hashes it by reading, and the
// published file must contain the exact bytes.
func TestAttachmentTextBeginWriteCommit(t *testing.T) {
	root := t.TempDir()
	serverID := "11111111-2222-4333-8444-555555555555"
	data := []byte("hello pairfob attachment\n")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	// Two sequential chunks: acknowledged offset must advance exactly.
	if err := stage.WriteAt(0, data[:10]); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if got := stage.Wrote(); got != 10 {
		t.Fatalf("wrote after first chunk = %d, want 10", got)
	}
	if err := stage.WriteAt(10, data[10:]); err != nil {
		t.Fatalf("second write: %v", err)
	}

	// Acknowledged bytes are already on disk in staging before commit.
	staged := filepath.Join(testBase(t, root), ".staging", serverID, "attachment.txt")
	if got, err := os.ReadFile(staged); err != nil || !bytes.Equal(got, data) {
		t.Fatalf("staged bytes before commit: got %q err %v, want %q", got, err, data)
	}

	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	wantRel := serverID + "/attachment.txt"
	if res.Rel != wantRel || !res.Published {
		t.Fatalf("committed rel = %q published=%v, want %q published=true", res.Rel, res.Published, wantRel)
	}
	if got := stage.FinalRel(); got != wantRel {
		t.Fatalf("FinalRel = %q, want %q", got, wantRel)
	}

	got, err := os.ReadFile(finalPathFor(t, root, res.Rel))
	if err != nil {
		t.Fatalf("read published file: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("published bytes = %q, want %q", got, data)
	}
	if sum := sha256Of(t, got); sum != sha256Of(t, data) {
		t.Fatalf("published digest %s, want %s", sum, sha256Of(t, data))
	}
	// The staging data file is gone (renamed away), nothing remains staged.
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Fatalf("staging data file still present after commit (err %v)", err)
	}
}

// TestAttachmentUnknownMimeFallsBackToBin covers the measured rejection of a
// valid but unlisted MIME (application/zip): MIME is metadata only and the
// safe fallback attachment.bin must publish the exact bytes.
func TestAttachmentUnknownMimeFallsBackToBin(t *testing.T) {
	root := t.TempDir()
	serverID := "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	// Not a real archive; only the bytes and digest matter.
	data := []byte("PK\x03\x04zip-bytes-never-interpreted")

	stage, err := BeginAttachment(root, serverID, "application/zip", int64(len(data)))
	if err != nil {
		t.Fatalf("begin application/zip: %v", err)
	}
	defer stage.Close()
	if got := stage.DataName(); got != "attachment.bin" {
		t.Fatalf("data name = %q, want attachment.bin", got)
	}
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if filepath.Base(res.Rel) != "attachment.bin" {
		t.Fatalf("committed basename = %q, want attachment.bin", filepath.Base(res.Rel))
	}
	got, err := os.ReadFile(finalPathFor(t, root, res.Rel))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("published zip bytes: got %q err %v, want %q", got, err, data)
	}
}

// TestAttachmentFilenameFallback pins the controlled-name fallback: every MIME
// outside the allowlist (including empty and junk) maps to attachment.bin, and
// nothing ever derives a name from client input.
func TestAttachmentFilenameFallback(t *testing.T) {
	cases := map[string]string{
		"text/plain":                "attachment.txt",
		"application/zip":           "attachment.bin",
		"application/octet-stream":  "attachment.bin",
		"":                          "attachment.bin",
		"../../etc/passwd":          "attachment.bin",
		"image/png; charset=binary": "attachment.bin",
	}
	for mime, want := range cases {
		if got := AttachmentFilename(mime); got != want {
			t.Fatalf("AttachmentFilename(%q) = %q, want %q", mime, got, want)
		}
	}
}

// TestAttachmentZeroByteCommit covers the empty file: no writes, commit
// verifies the empty digest and publishes a zero-byte file.
func TestAttachmentZeroByteCommit(t *testing.T) {
	root := t.TempDir()
	serverID := "00000000-1111-4222-8333-444444444444"

	stage, err := BeginAttachment(root, serverID, "text/plain", 0)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	rel, err := stage.Commit(0, sha256Of(t, nil))
	if err != nil {
		t.Fatalf("commit zero bytes: %v", err)
	}
	info, err := os.Stat(finalPathFor(t, root, rel.Rel))
	if err != nil {
		t.Fatalf("published zero-byte file missing: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("published size = %d, want 0", info.Size())
	}
}

// TestAttachmentCancelAfterCommitPreservesFile: aborting a committed stage
// must refuse and leave the finished file untouched.
func TestAttachmentCancelAfterCommitPreservesFile(t *testing.T) {
	root := t.TempDir()
	serverID := "99999999-8888-4777-8666-555555555555"
	data := []byte("committed bytes must survive cancel")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	rel, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := stage.Abort(); err != ErrConflict {
		t.Fatalf("abort after commit = %v, want ErrConflict", err)
	}
	got, err := os.ReadFile(finalPathFor(t, root, rel.Rel))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("file after committed cancel: got %q err %v, want %q", got, err, data)
	}
}

// TestAttachmentAbortRemovesStagingOnly: cancelling an unfinished upload
// removes the owned staging artifacts and never publishes.
func TestAttachmentAbortRemovesStagingOnly(t *testing.T) {
	root := t.TempDir()
	serverID := "77777777-6666-4555-8444-333333333333"

	stage, err := BeginAttachment(root, serverID, "application/zip", 64)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := stage.WriteAt(0, []byte("partial")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := stage.Abort(); err != nil {
		t.Fatalf("abort: %v", err)
	}
	if _, err := os.Stat(filepath.Join(testBase(t, root), ".staging", serverID)); !os.IsNotExist(err) {
		t.Fatalf("staging dir still present after abort (err %v)", err)
	}
	if _, err := os.Stat(filepath.Join(testBase(t, root), serverID)); !os.IsNotExist(err) {
		t.Fatalf("final dir exists after abort (err %v)", err)
	}
}

// TestAttachmentCommitFailsClosedOnDigestMismatch: a wrong declared digest
// must fail without publishing anything at the final path.
func TestAttachmentCommitFailsClosedOnDigestMismatch(t *testing.T) {
	root := t.TempDir()
	serverID := "12121212-3434-4565-8787-909090909090"
	data := []byte("content that will not match")

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(0, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := stage.Commit(int64(len(data)), sha256Of(t, []byte("different"))); err != ErrChanged {
		t.Fatalf("commit with wrong digest = %v, want ErrChanged", err)
	}
	if _, err := os.Stat(filepath.Join(testBase(t, root), serverID, "attachment.txt")); !os.IsNotExist(err) {
		t.Fatalf("file published despite digest mismatch (err %v)", err)
	}
	// The stage remains usable for a correct retry rather than guessing.
	rel, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if err != nil {
		t.Fatalf("retry commit after mismatch: %v", err)
	}
	if _, err := os.Stat(finalPathFor(t, root, rel.Rel)); err != nil {
		t.Fatalf("retry publish missing: %v", err)
	}
}

// TestAttachmentWriteBoundsStayClosed: existing bounds protections remain in
// force — wrong offset is a conflict, bytes past the declared size are
// rejected, and oversized chunks are refused.
func TestAttachmentWriteBoundsStayClosed(t *testing.T) {
	root := t.TempDir()
	serverID := "abcdefab-1234-4abc-8def-1234567890ab"

	stage, err := BeginAttachment(root, serverID, "text/plain", 8)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()
	if err := stage.WriteAt(1, []byte("x")); err != ErrConflict {
		t.Fatalf("write at wrong offset = %v, want ErrConflict", err)
	}
	if err := stage.WriteAt(0, []byte("123456789")); err != ErrInvalidRange {
		t.Fatalf("write past size = %v, want ErrInvalidRange", err)
	}
	if err := stage.WriteAt(0, make([]byte, AttachChunkBytes+1)); err != ErrTooLarge {
		t.Fatalf("oversized chunk = %v, want ErrTooLarge", err)
	}
	if got := stage.Wrote(); got != 0 {
		t.Fatalf("wrote = %d after rejected writes, want 0", got)
	}
}
