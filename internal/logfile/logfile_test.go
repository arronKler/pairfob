package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestWriteAppends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w, err := Open(path, 1024)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := w.Write([]byte("one\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := w.Write([]byte("two\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Sync(); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "one\ntwo\n" {
		t.Fatalf("content = %q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("mode = %o, want 0600", perm)
	}
}

func TestOpenTightensExistingMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	if err := os.WriteFile(path, []byte("old\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	w, err := Open(path, 1024)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("mode = %o, want 0600", perm)
	}
}

func TestRotationKeepsOneBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w, err := Open(path, 10)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer w.Close()
	for _, line := range []string{"111111\n", "222222\n", "333333\n", "444444\n"} {
		if _, err := w.Write([]byte(line)); err != nil {
			t.Fatalf("Write %q: %v", line, err)
		}
	}
	active, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile active: %v", err)
	}
	backup, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatalf("ReadFile backup: %v", err)
	}
	if string(active) != "444444\n" {
		t.Fatalf("active = %q", active)
	}
	if string(backup) != "333333\n" {
		t.Fatalf("backup = %q, want only the most recent rotated file", backup)
	}
	if _, err := os.Stat(path + ".2"); !os.IsNotExist(err) {
		t.Fatalf("unexpected second backup: %v", err)
	}
}

func TestRotationFailureKeepsWrites(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("directory permissions do not apply to root")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	w, err := Open(path, 32)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer w.Close()

	first := strings.Repeat("a", 20) + "\n"
	if _, err := w.Write([]byte(first)); err != nil {
		t.Fatalf("first Write: %v", err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	second := strings.Repeat("b", 20) + "\n"
	if _, err := w.Write([]byte(second)); err != nil {
		t.Fatalf("Write during failed rotation: %v", err)
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatalf("backup appeared despite read-only directory: %v", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("restore Chmod: %v", err)
	}

	third := strings.Repeat("c", 20) + "\n"
	if _, err := w.Write([]byte(third)); err != nil {
		t.Fatalf("Write after restore: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	backup, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatalf("ReadFile backup: %v", err)
	}
	if string(backup) != first+second {
		t.Fatalf("backup = %q, want both earlier writes", backup)
	}
	active, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile active: %v", err)
	}
	if string(active) != third {
		t.Fatalf("active = %q, want %q", active, third)
	}
}

func TestOpenRejectsNonRegular(t *testing.T) {
	dir := t.TempDir()
	if _, err := Open(dir, 1024); err == nil {
		t.Fatal("Open accepted a directory")
	}
	link := filepath.Join(dir, "link.log")
	target := filepath.Join(dir, "target.log")
	if err := os.WriteFile(target, []byte("x"), 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	if _, err := Open(link, 1024); err == nil {
		t.Fatal("Open accepted a symlink")
	}
}

func TestConcurrentWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	w, err := Open(path, 1<<20)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	const writers, perWriter = 8, 50
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < perWriter; j++ {
				if _, err := w.Write([]byte("line\n")); err != nil {
					t.Errorf("Write: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	lines := 0
	for _, name := range []string{path, path + ".1"} {
		data, err := os.ReadFile(name)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("ReadFile %s: %v", name, err)
		}
		lines += strings.Count(string(data), "line\n")
		if rem := len(data) % len("line\n"); rem != 0 {
			t.Fatalf("%s holds a split write: %d trailing bytes", name, rem)
		}
	}
	if lines != writers*perWriter {
		t.Fatalf("lines = %d, want %d", lines, writers*perWriter)
	}
}
