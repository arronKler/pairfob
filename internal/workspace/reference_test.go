package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveReference(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "Project", "pairfob")
	if err := os.MkdirAll(filepath.Join(root, "dir.with.dot"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "report with space.html"), []byte("html"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "no-extension"), []byte("text"), 0o600); err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ input, path, kind string }{
		{root, "", "directory"},
		{"~/Project/pairfob", "", "directory"},
		{"~/Project/pairfob/report with space.html", "report with space.html", "file"},
		{canonical + "/dir.with.dot", "dir.with.dot", "directory"},
		{root + "/no-extension", "no-extension", "file"},
	} {
		got, err := ResolveReference(root, canonical, home, tc.input)
		if err != nil || got.Root != canonical || got.Path != tc.path || got.Kind != tc.kind {
			t.Fatalf("%q: %+v %v", tc.input, got, err)
		}
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{home, root + "-sibling/report.html", "~/elsewhere/report.html", root + "/escape", root + "/../pairfob/no-extension", root + "/.git/config", root + "/x\x00", "relative.html", "~other/Project/pairfob"} {
		if _, err := ResolveReference(root, canonical, home, input); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("accepted %q: %v", input, err)
		}
	}
	if _, err := ResolveReference(root, outside, home, root); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("stale root: %v", err)
	}
	// A path alias must not bypass the repository-internals check.
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, ".git"), filepath.Join(root, "metadata")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveReference(root, canonical, home, root+"/metadata"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf(".git alias: %v", err)
	}
}
