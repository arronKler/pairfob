//go:build unix

package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestOpenMediaRejectsParentSymlinkSwapBeforeOpen(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.bin"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "file.bin"), []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mediaOpenHook = nil })
	mediaOpenHook = func(stage, relative string) {
		if stage != "pre-open" || relative != "dir/file.bin" {
			return
		}
		if err := os.RemoveAll(filepath.Join(root, "dir")); err != nil {
			t.Errorf("remove dir: %v", err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "dir")); err != nil {
			t.Errorf("symlink: %v", err)
		}
	}
	if _, err := NewInspector().OpenMedia(root, "dir/file.bin"); !errors.Is(err, ErrInvalidPath) && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrChanged) {
		t.Fatalf("parent swap err=%v", err)
	}
}

func TestOpenMediaRejectsFIFOSwapWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "clip.bin")
	if err := os.WriteFile(path, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mediaOpenHook = nil })
	mediaOpenHook = func(stage, relative string) {
		if stage != "pre-open" {
			return
		}
		if err := os.Remove(path); err != nil {
			t.Errorf("remove: %v", err)
		}
		if err := unix.Mkfifo(path, 0o600); err != nil {
			t.Errorf("mkfifo: %v", err)
		}
	}
	start := time.Now()
	_, err := NewInspector().OpenMedia(root, "clip.bin")
	if time.Since(start) > 500*time.Millisecond {
		t.Fatalf("FIFO open blocked for %s", time.Since(start))
	}
	if !errors.Is(err, ErrInvalidPath) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("fifo swap err=%v", err)
	}
}

func TestOpenMediaRejectsLeafSymlinkThroughRoot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.bin")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewInspector().OpenMedia(root, "escape"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("leaf symlink err=%v", err)
	}
}
