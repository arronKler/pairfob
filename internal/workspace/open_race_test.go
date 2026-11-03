//go:build unix

package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests use the media pre-open seam to replace a checked path with a
// symlink at the last possible moment. The read must open through os.Root and
// re-check the descriptor, so the swapped link is never followed.

func withPreOpenSwap(t *testing.T, relative string, swap func()) {
	t.Helper()
	t.Cleanup(func() { mediaOpenHook = nil })
	mediaOpenHook = func(stage, name string) {
		if stage == "pre-open" && name == relative {
			swap()
		}
	}
}

func TestReadRejectsParentSymlinkSwapAfterAuthorization(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "file.txt"), []byte("outside secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeInside := func() {
		t.Helper()
		if err := os.RemoveAll(filepath.Join(root, "dir")); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "dir", "file.txt"), []byte("inside\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	withPreOpenSwap(t, "dir/file.txt", func() {
		if err := os.RemoveAll(filepath.Join(root, "dir")); err != nil {
			t.Errorf("remove dir: %v", err)
			return
		}
		if err := os.Symlink(outside, filepath.Join(root, "dir")); err != nil {
			t.Errorf("symlink dir: %v", err)
		}
	})
	writeInside()
	if view, err := NewInspector().Read(root, "dir/file.txt"); err == nil {
		t.Fatalf("Read followed the swapped parent symlink: %q", view.Content)
	}
	writeInside()
	if patch, _, _, err := untrackedPatch(root, "dir/file.txt"); err == nil {
		t.Fatalf("untrackedPatch followed the swapped parent symlink: %q", patch)
	}
	writeInside()
	if count, ok := untrackedCount(root, "dir/file.txt"); ok {
		t.Fatalf("untrackedCount followed the swapped parent symlink: %+v", count)
	}
}

func TestReadRejectsLeafSymlinkSwapAfterAuthorization(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("outside secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "file.txt")
	writeInside := func() {
		t.Helper()
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("inside\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	withPreOpenSwap(t, "file.txt", func() {
		if err := os.Remove(path); err != nil {
			t.Errorf("remove file: %v", err)
			return
		}
		if err := os.Symlink(outside, path); err != nil {
			t.Errorf("symlink file: %v", err)
		}
	})
	writeInside()
	if view, err := NewInspector().Read(root, "file.txt"); err == nil {
		t.Fatalf("Read followed the swapped leaf symlink: %q", view.Content)
	}
	writeInside()
	if patch, _, _, err := untrackedPatch(root, "file.txt"); err == nil || strings.Contains(patch, "outside secret") {
		t.Fatalf("untrackedPatch followed the swapped leaf symlink: patch=%q err=%v", patch, err)
	}
	writeInside()
	if count, ok := untrackedCount(root, "file.txt"); ok {
		t.Fatalf("untrackedCount followed the swapped leaf symlink: %+v", count)
	}
}
