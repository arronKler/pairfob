package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestScanScopeHomeAndAncestors(t *testing.T) {
	for _, tc := range []struct {
		root  string
		broad bool
	}{
		{"/", true}, {"/Users", true}, {"/Users/example", true},
		{"/Users/example/project", false}, {"/Users/example/Downloads/project", false},
		{"/Users/examples", false}, {"/work/project", false},
	} {
		if got := containsHome(tc.root, "/Users/example"); got != tc.broad {
			t.Errorf("%s: broad=%v", tc.root, got)
		}
	}
}

func TestMacHomeScanDoesNotStartGitOrWalk(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS privacy scan policy")
	}
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	bin := t.TempDir()
	marker := filepath.Join(bin, "git-called")
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte("#!/bin/sh\ntouch \"$SCAN_MARKER\"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("SCAN_MARKER", marker)
	searchFixture(t, home, "Downloads/private.txt", "Pictures/library/private.txt", "Library/Containers/private.txt")
	alias := filepath.Join(t.TempDir(), "home-alias")
	if err := os.Symlink(home, alias); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{home, alias, filepath.Dir(home)} {
		if _, err := NewInspector().Search(root, "private", 10); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("broad search %s: %v", root, err)
		}
		if _, err := NewInspector().Status(root); !errors.Is(err, ErrNotRepository) {
			t.Fatalf("broad status %s: %v", root, err)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("broad scope launched Git: %v", err)
	}
	// Listing HOME itself doesn't descend into protected children.
	if _, err := NewInspector().List(home, "", "", 20); err != nil {
		t.Fatal(err)
	}
}

func TestMacSpecificProjectStillSearchesAndShowsGit(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS privacy scan policy")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	project := gitFixture(t)
	searchFixture(t, project, "readme.txt")
	if _, err := NewInspector().Status(project); err != nil {
		t.Fatal(err)
	}
	project = filepath.Join(home, "Downloads", "project")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	searchFixture(t, project, "readme.txt")
	page, err := NewInspector().Search(project, "readme", 10)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("specific project: %+v %v", page, err)
	}
}

func TestMacHomeRepositoryDoesNotScanFromProjectChild(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS privacy scan policy")
	}
	home := gitFixture(t)
	t.Setenv("HOME", home)
	project := filepath.Join(home, "project")
	searchFixture(t, home, "project/readme.txt", "Pictures/private.txt")
	// Git may refresh index entries outside a pathspec. Do not use a broad
	// parent repository even when the workspace itself has a specific cwd.
	if _, err := NewInspector().Status(project); !errors.Is(err, ErrNotRepository) {
		t.Fatalf("home repository inherited by child: %v", err)
	}
	page, err := NewInspector().Search(project, "readme", 10)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("bounded child walk: %+v %v", page, err)
	}
}
