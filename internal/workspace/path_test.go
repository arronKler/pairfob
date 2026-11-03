package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanRelativeRejectsGitMetadataInEveryComponent(t *testing.T) {
	for _, value := range []string{
		".git", ".GIT", ".Git",
		".git/config", ".GIT/config", ".Git/objects/ab/cdef",
		"nested/.git/config", "nested/.GIT", "a/b/.Git/c",
	} {
		if _, err := cleanRelative(value); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("cleanRelative(%q) err=%v, want ErrInvalidPath", value, err)
		}
	}
	// Names that merely resemble Git metadata stay ordinary file names.
	for _, value := range []string{
		".gitignore", ".gitmodules", ".github/workflows/ci.yml",
		"git/config", "sub/.gitkeep", "a.git/config",
	} {
		clean, err := cleanRelative(value)
		if err != nil || clean != value {
			t.Fatalf("cleanRelative(%q)=%q err=%v, want an ordinary name", value, clean, err)
		}
	}
}

// A symlink can give Git metadata an ordinary name; the resolved target is
// what the file operations would read.
func TestGitMetadataCannotBeReachedThroughASymlinkAlias(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("[core]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".git", filepath.Join(root, "alias")); err != nil {
		t.Skipf("symlink: %v", err)
	}
	inspector := NewInspector()
	for _, relative := range []string{"alias", "alias/config"} {
		if _, err := inspector.Read(root, relative); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("Read(%q) err=%v, want ErrInvalidPath", relative, err)
		}
		if _, err := inspector.List(root, relative, "", 20); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("List(%q) err=%v, want ErrInvalidPath", relative, err)
		}
		if _, err := inspector.OpenMedia(root, relative); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("OpenMedia(%q) err=%v, want ErrInvalidPath", relative, err)
		}
	}
}

func TestInspectorRejectsGitMetadataPathsInAnyCaseAndDepth(t *testing.T) {
	root := t.TempDir()
	for path, content := range map[string]string{
		".GIT/config":           "[core]\n",
		"nested/.git/config":    "[core]\n",
		"nested/.GIT/objects/x": "object",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	inspector := NewInspector()
	for _, relative := range []string{
		".GIT/config", ".Git/config",
		"nested/.git/config", "nested/.GIT/objects/x",
	} {
		if _, err := inspector.Read(root, relative); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("Read(%q) err=%v, want ErrInvalidPath", relative, err)
		}
		if _, err := inspector.List(root, relative, "", 20); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("List(%q) err=%v, want ErrInvalidPath", relative, err)
		}
		if _, err := inspector.OpenMedia(root, relative); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("OpenMedia(%q) err=%v, want ErrInvalidPath", relative, err)
		}
		if _, err := inspector.OpenDownloadContext(context.Background(), root, relative, 0, nil); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("OpenDownloadContext(%q) err=%v, want ErrInvalidPath", relative, err)
		}
	}
	for _, directory := range []string{"nested/.git", "nested/.GIT", ".Git"} {
		if _, err := inspector.List(root, directory, "", 20); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("List(%q) err=%v, want ErrInvalidPath", directory, err)
		}
	}
	// The metadata directories are hidden from their parent listing, and hiding
	// them is not a truncation.
	for _, parent := range []string{"", "nested"} {
		page, err := inspector.List(root, parent, "", 20)
		if err != nil {
			t.Fatalf("List(%q) err=%v", parent, err)
		}
		if page.Truncated {
			t.Fatalf("List(%q) truncated for a hidden metadata entry: %+v", parent, page.Entries)
		}
		for _, entry := range page.Entries {
			if strings.EqualFold(entry.Name, ".git") {
				t.Fatalf("List(%q) exposes git metadata: %+v", parent, page.Entries)
			}
		}
	}
}
