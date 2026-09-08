package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMutateFile(t *testing.T) {
	root := t.TempDir()
	canonical, _ := canonicalRoot(root)
	path := filepath.Join(root, "a.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	mutate := func(name, target string, rename bool) error {
		return MutateFile(root, canonical, name, target, FileRevision(info), info.Size(), info.ModTime().UnixMilli(), rename)
	}
	for _, name := range []string{"../a.txt", "/a.txt", "./a.txt", ".git/config", ".GIT/config", "sub/../a.txt", "a.txt/child"} {
		if err := mutate(name, "b.txt", true); err == nil {
			t.Fatalf("accepted path %q", name)
		}
	}
	for _, name := range []string{"", ".", "..", ".git", ".GIT", "../b.txt", "a/b", "a\\b", "a\n"} {
		if err := mutate("a.txt", name, true); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("name %q: %v", name, err)
		}
	}
	if err := MutateFile(root, canonical+"/other", "a.txt", "b.txt", FileRevision(info), info.Size(), info.ModTime().UnixMilli(), true); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("changed root: %v", err)
	}
	if err := MutateFile(root, canonical, "a.txt", "b.txt", FileRevision(info), 0, info.ModTime().UnixMilli(), true); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := mutate("a.txt", "b.txt", true); !errors.Is(err, os.ErrExist) {
		t.Fatalf("overwrite: %v", err)
	}
	kept, _ := os.ReadFile(filepath.Join(root, "b.txt"))
	if string(kept) != "keep" {
		t.Fatal("overwritten destination")
	}
	if err := mutate("a.txt", "renamed.txt", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old name exists")
	}
	if err := mutate("renamed.txt", "", false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "renamed.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("file not deleted")
	}
}

func TestMutateFileRejectsLinksDirectoriesAndNestedGit(t *testing.T) {
	root := t.TempDir()
	canonical, _ := canonicalRoot(root)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"dir", "nested/.git"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "nested/.git/config"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"linked": outside, "file-link": filepath.Join(outside, "secret"), "git-link": filepath.Join(root, "nested/.git")} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"dir", "linked/secret", "file-link", "nested/.git/config", "git-link/config"} {
		for _, rename := range []bool{true, false} {
			if err := MutateFile(root, canonical, name, "new", "", 4, 0, rename); !errors.Is(err, ErrInvalidPath) {
				t.Fatalf("%s rename=%v: %v", name, rename, err)
			}
		}
	}
	if data, _ := os.ReadFile(filepath.Join(outside, "secret")); string(data) != "keep" {
		t.Fatal("outside file changed")
	}
}

func TestMutateRejectsSameSizeSameMillisecondReplacement(t *testing.T) {
	root := t.TempDir()
	canonical, _ := canonicalRoot(root)
	original := filepath.Join(root, "a.txt")
	replacement := filepath.Join(root, "b.txt")
	for _, path := range []string{original, replacement} {
		if err := os.WriteFile(path, []byte("data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	first, _ := os.Stat(original)
	// Match timestamp exactly: inode identity must still reject a replacement.
	if err := os.Chtimes(replacement, first.ModTime(), first.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, original); err != nil {
		t.Fatal(err)
	}
	for _, rename := range []bool{true, false} {
		err := MutateFile(root, canonical, "a.txt", "c.txt", FileRevision(first), first.Size(), first.ModTime().UnixMilli(), rename)
		if !errors.Is(err, ErrConflict) {
			t.Fatalf("replacement rename=%v: %v", rename, err)
		}
	}
	if _, err := os.Stat(original); err != nil {
		t.Fatal("replacement removed")
	}
}
