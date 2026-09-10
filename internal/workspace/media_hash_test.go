package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

func TestOpenMediaDoesNotReadWhenAdmitRejects(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.bin"), make([]byte, 128<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int64
	restore := SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	blocked := errors.New("blocked")
	_, err := NewInspector().OpenMediaContext(context.Background(), root, "clip.bin", func(context.Context, int64) error {
		return blocked
	})
	if !errors.Is(err, blocked) {
		t.Fatalf("err=%v", err)
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("read %d bytes before admit rejected", got)
	}
}

func TestOpenMediaStatCapDoesNotRead(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "huge.bin"), make([]byte, MaxMediaBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int64
	restore := SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	if _, err := NewInspector().OpenMedia(root, "huge.bin"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err=%v", err)
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("hashed %d bytes of an oversize file", got)
	}
}

func TestOpenMediaKindCapStopsAfterSniff(t *testing.T) {
	root := t.TempDir()
	payload := make([]byte, MaxMediaImageBytes+1)
	copy(payload, []byte{
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
	})
	if err := os.WriteFile(filepath.Join(root, "wide.png"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	var reads atomic.Int64
	restore := SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	if _, err := NewInspector().OpenMedia(root, "wide.png"); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err=%v", err)
	}
	if got := reads.Load(); got != mediaSniffBytes {
		t.Fatalf("sniffed %d, want %d", got, mediaSniffBytes)
	}
}
