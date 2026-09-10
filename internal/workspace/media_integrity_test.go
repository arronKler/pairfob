package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenMediaDetectsReplacementAndRewrite(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.bin")
	if err := os.WriteFile(path, []byte("version-one-data"), 0o644); err != nil {
		t.Fatal(err)
	}
	opened, err := NewInspector().OpenMedia(root, "clip.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if err := os.WriteFile(path, []byte("version-two-data!!"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := opened.ReadChunk(0, 4); !errors.Is(err, ErrChanged) {
		t.Fatalf("rewrite err=%v", err)
	}
}

func TestOpenMediaDetectsDelete(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "gone.bin")
	if err := os.WriteFile(path, []byte("delete-me"), 0o644); err != nil {
		t.Fatal(err)
	}
	opened, err := NewInspector().OpenMedia(root, "gone.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, _, err := opened.ReadChunk(0, 1); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrChanged) {
		t.Fatalf("deleted err=%v", err)
	}
}

func TestOpenMediaRejectsSymlinkSwapAfterStat(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "real.bin")
	if err := os.WriteFile(inside, bytesOf('a', 32), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "swap.bin")
	if err := os.WriteFile(target, bytesOf('b', 32), 0o644); err != nil {
		t.Fatal(err)
	}
	opened, err := NewInspector().OpenMedia(root, "swap.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(inside, target); err != nil {
		t.Fatal(err)
	}
	if _, _, err := opened.ReadChunk(0, 8); !errors.Is(err, ErrChanged) && !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("symlink swap err=%v", err)
	}
}

func bytesOf(value byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = value
	}
	return out
}
