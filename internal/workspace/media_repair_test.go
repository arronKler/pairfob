package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// --- W1: relative leaf symlinks must never be opened or hashed --------------

func TestMediaRepairRejectsExistingRelativeLeafSymlink(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "regular.bin"), []byte("workspace-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Relative target: os.Root.OpenFile follows this in-root link even with
	// O_NOFOLLOW, so the explicit Lstat leaf policy has to reject it.
	if err := os.Symlink("regular.bin", filepath.Join(root, "alias.bin")); err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int64
	restore := SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	m, err := NewInspector().OpenMedia(root, "alias.bin")
	if m != nil {
		_ = m.Close()
		t.Fatalf("relative leaf symlink opened: %+v", m.Info())
	}
	if !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("relative leaf symlink err=%v; want ErrInvalidPath", err)
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("read %d bytes through a forbidden leaf symlink", got)
	}
}

func TestMediaRepairRejectsRelativeLeafSymlinkIntroducedAtPreOpenSwap(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target.bin")
	leaf := filepath.Join(root, "clip.bin")
	if err := os.WriteFile(target, bytes.Repeat([]byte("t"), 64), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(leaf, bytes.Repeat([]byte("c"), 64), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mediaOpenHook = nil })
	mediaOpenHook = func(stage, relative string) {
		if stage != "pre-open" || relative != "clip.bin" {
			return
		}
		if err := os.Remove(leaf); err != nil {
			t.Errorf("remove leaf: %v", err)
		}
		// Relative link introduced in the pre-open swap window; OpenFile would
		// follow it to target.bin, so the post-open name/descriptor check must
		// reject the swapped leaf.
		if err := os.Symlink("target.bin", leaf); err != nil {
			t.Errorf("symlink leaf: %v", err)
		}
	}
	var reads atomic.Int64
	restore := SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	m, err := NewInspector().OpenMedia(root, "clip.bin")
	if m != nil {
		_ = m.Close()
		t.Fatalf("pre-open relative symlink swap opened: %+v", m.Info())
	}
	if !errors.Is(err, ErrInvalidPath) && !errors.Is(err, ErrChanged) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("pre-open swap err=%v", err)
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("read %d bytes through a swapped leaf symlink", got)
	}
}

// --- W2: a same-inode rewrite/growth during hashing is never published ------

func admitRewriteAt(call int, mutate func() error) (MediaAdmit, *int) {
	calls := 0
	return func(context.Context, int64) error {
		calls++
		if calls == call {
			return mutate()
		}
		return nil
	}, &calls
}

func TestMediaRepairRejectsSameInodeRewriteDuringHash(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.bin")
	old := bytes.Repeat([]byte("a"), 2*mediaSniffBytes)
	next := bytes.Repeat([]byte("b"), len(old))
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	before := time.Unix(1_600_000_000, 0)
	if err := os.Chtimes(path, before, before); err != nil {
		t.Fatal(err)
	}
	after := before.Add(time.Hour)
	admit, calls := admitRewriteAt(2, func() error {
		// os.WriteFile truncates and rewrites the SAME path/inode, then advances
		// mtime: an ordinary same-inode rewrite, no privilege or metadata restore.
		if err := os.WriteFile(path, next, 0o600); err != nil {
			return err
		}
		return os.Chtimes(path, after, after)
	})
	m, err := NewInspector().OpenMediaContext(context.Background(), root, "clip.bin", admit)
	if m != nil {
		_ = m.Close()
		t.Fatalf("rewrite during hash published %+v", m.Info())
	}
	if *calls != 2 {
		t.Fatalf("admission schedule=%d, want 2", *calls)
	}
	if !errors.Is(err, ErrChanged) {
		t.Fatalf("same-inode rewrite during hash err=%v; want ErrChanged", err)
	}
}

func TestMediaRepairRejectsGrowthDuringHash(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.bin")
	original := bytes.Repeat([]byte("a"), 2*mediaSniffBytes)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	admit, calls := admitRewriteAt(2, func() error {
		// Same inode, grown: append a byte so the post-hash size no longer matches.
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.Write([]byte("z"))
		return err
	})
	m, err := NewInspector().OpenMediaContext(context.Background(), root, "clip.bin", admit)
	if m != nil {
		_ = m.Close()
		t.Fatalf("growth during hash published %+v", m.Info())
	}
	if *calls != 2 {
		t.Fatalf("admission schedule=%d, want 2", *calls)
	}
	if !errors.Is(err, ErrChanged) {
		t.Fatalf("growth during hash err=%v; want ErrChanged", err)
	}
}

func TestMediaRepairValidFullHashSurvivesAndReads(t *testing.T) {
	root := t.TempDir()
	payload := bytes.Repeat([]byte("a"), 2*mediaSniffBytes)
	if err := os.WriteFile(filepath.Join(root, "clip.bin"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := NewInspector().OpenMedia(root, "clip.bin")
	if err != nil {
		t.Fatalf("valid open err=%v", err)
	}
	defer m.Close()
	sum := sha256.Sum256(payload)
	if m.Info().Size != int64(len(payload)) || m.Info().SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("info=%+x... size=%d", m.Info().SHA256, m.Info().Size)
	}
	chunk, eof, err := m.ReadChunk(0, MediaChunkBytes)
	if err != nil || eof || !bytes.Equal(chunk, payload[:MediaChunkBytes]) {
		t.Fatalf("first chunk eof=%v err=%v", eof, err)
	}
	if err := m.Recheck(); err != nil {
		t.Fatalf("stable file recheck err=%v", err)
	}
}

// --- W3: ADTS AAC is recognized; real MP3 frames stay audio/mpeg ------------

func adtsHeader(second byte) []byte {
	// Minimal ADTS fixed header (sync 0xFFF, MPEG id, layer 00, protection absent)
	// followed by a declared frame; padded for the sniffer. No codec runtime.
	head := []byte{0xff, second, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0x00}
	return append(head, make([]byte, 248)...)
}

func TestMediaRepairADTSIsAudioAAC(t *testing.T) {
	for _, second := range []byte{0xf1, 0xf9} {
		head := adtsHeader(second)
		kind, mime, _, _ := sniffMedia(head, int64(len(head)))
		if kind != MediaAudio || mime != "audio/aac" {
			t.Fatalf("ADTS %x sniffed as %s/%s; want audio/aac", second, kind, mime)
		}
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "song.aac"), head, 0o600); err != nil {
			t.Fatal(err)
		}
		m, err := NewInspector().OpenMedia(root, "song.aac")
		if err != nil {
			t.Fatalf("ADTS open err=%v", err)
		}
		if m.Info().MIME != "audio/aac" {
			_ = m.Close()
			t.Fatalf("ADTS file MIME=%s; want audio/aac", m.Info().MIME)
		}
		_ = m.Close()
	}
}

func TestMediaRepairMPEGFramesStayAudioMPEG(t *testing.T) {
	// Real MP3 frame syncs across versions and layers; layer bits are non-zero.
	for _, second := range []byte{0xfb, 0xfa, 0xfc, 0xfe, 0xf3, 0xf2} {
		head := append([]byte{0xff, second}, make([]byte, 32)...)
		kind, mime, _, _ := sniffMedia(head, int64(len(head)))
		if kind != MediaAudio || mime != "audio/mpeg" {
			t.Fatalf("MP3 frame ff %x sniffed as %s/%s; want audio/mpeg", second, kind, mime)
		}
	}
	// An ID3-tagged MP3 still classifies as MPEG audio.
	id3 := append([]byte("ID3\x03\x00\x00\x00\x00\x00\x00"), make([]byte, 32)...)
	kind, mime, _, _ := sniffMedia(id3, int64(len(id3)))
	if kind != MediaAudio || mime != "audio/mpeg" {
		t.Fatalf("ID3 mp3 sniffed as %s/%s; want audio/mpeg", kind, mime)
	}
	// Reserved layer (0b00) that is not ADTS is not promoted to audio/mpeg.
	reserved := append([]byte{0xff, 0xe9}, make([]byte, 32)...) // sync, version set, layer 00, id bit
	kind, _, _, _ = sniffMedia(reserved, int64(len(reserved)))
	if kind == MediaAudio {
		t.Fatalf("reserved-layer frame classified as audio")
	}
}
