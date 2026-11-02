//go:build unix

// Focused tests for the stage-2 larger-chunk write path (WriteAtV2 /
// AttachChunkBytesV2 = 131072). The legacy WriteAt bound stays 32768, V2
// accepts exactly one 128 KiB chunk with the same sequential, durable-offset
// semantics, every rejected write leaves the acknowledged offset and the
// staged bytes untouched, and a full 128 KiB upload commits with a matching
// SHA-256. No RPC or server-pipeline behaviour is exercised here.
package workspace

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// attachPattern fills n deterministic, non-repeating bytes keyed by absolute
// index, so a head and a tail slice compare equal to the same range of a
// single full buffer.
func attachPattern(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(i*31 + 7)
	}
	return out
}

func stagedPathV2(t *testing.T, root, serverID string) string {
	t.Helper()
	return stagedPathV2Name(t, root, serverID, "attachment.txt")
}

// stagedPathV2Name is stagedPathV2 with the controlled data basename derived
// from the stage's MIME type (application/octet-stream stages attachment.bin).
func stagedPathV2Name(t *testing.T, root, serverID, dataName string) string {
	t.Helper()
	return filepath.Join(testBase(t, root), ".staging", serverID, dataName)
}

// TestAttachWriteV2LegacyBoundUnchanged: the old WriteAt still caps a chunk
// at AttachChunkBytes; a 32769-byte write is refused even when the declared
// size allows it, while exactly 32768 still lands.
func TestAttachWriteV2LegacyBoundUnchanged(t *testing.T) {
	root := t.TempDir()
	serverID := "10000001-2002-4003-8004-a00000000001"

	stage, err := BeginAttachment(root, serverID, "text/plain", AttachMaxFileBytes)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	if err := stage.WriteAt(0, make([]byte, AttachChunkBytes+1)); err != ErrTooLarge {
		t.Fatalf("legacy WriteAt(%d bytes) = %v, want ErrTooLarge", AttachChunkBytes+1, err)
	}
	if got := stage.Wrote(); got != 0 {
		t.Fatalf("wrote after oversized legacy write = %d, want 0", got)
	}
	if err := stage.WriteAt(0, make([]byte, AttachChunkBytes)); err != nil {
		t.Fatalf("legacy WriteAt(%d bytes) at the limit: %v", AttachChunkBytes, err)
	}
	if got := stage.Wrote(); got != AttachChunkBytes {
		t.Fatalf("wrote after limit-sized legacy write = %d, want %d", got, AttachChunkBytes)
	}
}

// TestAttachWriteV2RejectsOverLimit: WriteAtV2 refuses a 131073-byte chunk
// even though the declared size (20 MiB) would allow the bytes.
func TestAttachWriteV2RejectsOverLimit(t *testing.T) {
	root := t.TempDir()
	serverID := "10000002-2002-4003-8004-a00000000002"

	stage, err := BeginAttachment(root, serverID, "application/octet-stream", AttachMaxFileBytes)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	if err := stage.WriteAtV2(0, make([]byte, AttachChunkBytesV2+1)); err != ErrTooLarge {
		t.Fatalf("WriteAtV2(%d bytes) = %v, want ErrTooLarge", AttachChunkBytesV2+1, err)
	}
	if got := stage.Wrote(); got != 0 {
		t.Fatalf("wrote after oversized V2 write = %d, want 0", got)
	}
	if info, err := os.Stat(stagedPathV2Name(t, root, serverID, "attachment.bin")); err != nil || info.Size() != 0 {
		t.Fatalf("staged file after oversized V2 write: %v (size=%d), want 0-byte file", err, statSize(info))
	}
}

// statSize is nil-safe for Fatalf messages: os.Stat's info is nil on error.
func statSize(info os.FileInfo) int64 {
	if info == nil {
		return -1
	}
	return info.Size()
}

// TestAttachWriteV2AcceptsFullChunkDurable: one WriteAtV2 of exactly
// 131072 bytes succeeds, the acknowledged durable offset becomes 131072, and
// all bytes are already on disk in staging.
func TestAttachWriteV2AcceptsFullChunkDurable(t *testing.T) {
	root := t.TempDir()
	serverID := "10000003-2002-4003-8004-a00000000003"
	data := attachPattern(AttachChunkBytesV2)

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	if err := stage.WriteAtV2(0, data); err != nil {
		t.Fatalf("WriteAtV2(%d bytes): %v", len(data), err)
	}
	if got := stage.Wrote(); got != AttachChunkBytesV2 {
		t.Fatalf("wrote after full V2 chunk = %d, want %d", got, AttachChunkBytesV2)
	}
	got, err := os.ReadFile(stagedPathV2(t, root, serverID))
	if err != nil {
		t.Fatalf("read staged bytes: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("staged %d bytes do not match written %d bytes", len(got), len(data))
	}
}

// TestAttachWriteV2WrongOffsetNoWrite: writes at an offset other than the
// acknowledged offset are conflicts, touch no bytes and never advance the
// offset; the correct sequential continuation still lands.
func TestAttachWriteV2WrongOffsetNoWrite(t *testing.T) {
	root := t.TempDir()
	serverID := "10000004-2002-4003-8004-a00000000004"
	full := attachPattern(12288)

	stage, err := BeginAttachment(root, serverID, "text/plain", AttachChunkBytesV2)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	if err := stage.WriteAtV2(1, []byte("x")); err != ErrConflict {
		t.Fatalf("V2 write at offset 1 = %v, want ErrConflict", err)
	}
	if got := stage.Wrote(); got != 0 {
		t.Fatalf("wrote after offset-1 conflict = %d, want 0", got)
	}
	if info, err := os.Stat(stagedPathV2(t, root, serverID)); err != nil || info.Size() != 0 {
		t.Fatalf("staged file after offset-1 conflict: %v (size=%d), want 0-byte file", err, statSize(info))
	}

	if err := stage.WriteAtV2(0, full[:4096]); err != nil {
		t.Fatalf("first sequential V2 write: %v", err)
	}
	if err := stage.WriteAtV2(4095, []byte("z")); err != ErrConflict {
		t.Fatalf("V2 write at stale offset = %v, want ErrConflict", err)
	}
	if got := stage.Wrote(); got != 4096 {
		t.Fatalf("wrote after stale-offset conflict = %d, want 4096", got)
	}
	if err := stage.WriteAtV2(4096, full[4096:12288]); err != nil {
		t.Fatalf("continued sequential V2 write: %v", err)
	}
	if got := stage.Wrote(); got != 12288 {
		t.Fatalf("wrote after continuation = %d, want 12288", got)
	}
	got, err := os.ReadFile(stagedPathV2(t, root, serverID))
	if err != nil || !bytes.Equal(got, full) {
		t.Fatalf("staged bytes after continuation: len=%d err=%v, want %d contiguous bytes", len(got), err, len(full))
	}
}

// TestAttachWriteV2FailuresNeverAdvance: every rejection class (oversized
// chunk, wrong offset, write past declared size) leaves Wrote at zero, and the
// stage remains usable for the correct sequential write afterwards.
func TestAttachWriteV2FailuresNeverAdvance(t *testing.T) {
	root := t.TempDir()
	serverID := "10000005-2002-4003-8004-a00000000005"

	stage, err := BeginAttachment(root, serverID, "text/plain", 100)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	// Chunk limit is checked against AttachChunkBytesV2 even on a small
	// declared size.
	if err := stage.WriteAtV2(0, make([]byte, AttachChunkBytesV2+1)); err != ErrTooLarge {
		t.Fatalf("oversized V2 chunk = %v, want ErrTooLarge", err)
	}
	if err := stage.WriteAtV2(5, []byte("x")); err != ErrConflict {
		t.Fatalf("wrong-offset V2 write = %v, want ErrConflict", err)
	}
	if err := stage.WriteAtV2(0, make([]byte, 101)); err != ErrInvalidRange {
		t.Fatalf("V2 write past declared size = %v, want ErrInvalidRange", err)
	}
	if got := stage.Wrote(); got != 0 {
		t.Fatalf("wrote after rejected writes = %d, want 0", got)
	}
	if info, err := os.Stat(stagedPathV2(t, root, serverID)); err != nil || info.Size() != 0 {
		t.Fatalf("staged file after rejected writes: %v (size=%d), want 0-byte file", err, statSize(info))
	}

	// The failed attempts poison nothing: the in-order write still lands.
	good := attachPattern(100)
	if err := stage.WriteAtV2(0, good); err != nil {
		t.Fatalf("valid V2 write after rejections: %v", err)
	}
	if got := stage.Wrote(); got != 100 {
		t.Fatalf("wrote after valid write = %d, want 100", got)
	}
	got, err := os.ReadFile(stagedPathV2(t, root, serverID))
	if err != nil || !bytes.Equal(got, good) {
		t.Fatalf("staged bytes after recovery: len=%d err=%v, want 100", len(got), err)
	}
}

// TestAttachWriteV2CommitFullChunkSHA: a full 128 KiB V2 upload commits, and
// the published file is byte-identical with a matching SHA-256.
func TestAttachWriteV2CommitFullChunkSHA(t *testing.T) {
	root := t.TempDir()
	serverID := "10000006-2002-4003-8004-a00000000006"
	data := attachPattern(AttachChunkBytesV2)

	stage, err := BeginAttachment(root, serverID, "text/plain", int64(len(data)))
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer stage.Close()

	if err := stage.WriteAtV2(0, data); err != nil {
		t.Fatalf("WriteAtV2 full chunk: %v", err)
	}
	res, err := stage.Commit(int64(len(data)), sha256Of(t, data))
	if err != nil {
		t.Fatalf("commit full V2 chunk: %v", err)
	}
	wantRel := serverID + "/attachment.txt"
	if res.Rel != wantRel || !res.Published {
		t.Fatalf("commit result = %+v, want %q published=true", res, wantRel)
	}
	published, err := os.ReadFile(finalPathFor(t, root, res.Rel))
	if err != nil {
		t.Fatalf("read published file: %v", err)
	}
	if !bytes.Equal(published, data) {
		t.Fatalf("published %d bytes differ from written %d bytes", len(published), len(data))
	}
	if got, want := sha256Of(t, published), sha256Of(t, data); got != want {
		t.Fatalf("published SHA-256 = %s, want %s", got, want)
	}
}
