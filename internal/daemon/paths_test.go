package daemon

import (
	"os"
	"path/filepath"
	"testing"

	"pairfob/internal/runtime"
)

func unsetAllowedRoots(t *testing.T) {
	t.Helper()
	value, present := os.LookupEnv("PAIRFOB_ALLOWED_ROOTS")
	if err := os.Unsetenv("PAIRFOB_ALLOWED_ROOTS"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if present {
			_ = os.Setenv("PAIRFOB_ALLOWED_ROOTS", value)
		} else {
			_ = os.Unsetenv("PAIRFOB_ALLOWED_ROOTS")
		}
	})
}

func TestConfiguredAllowedRootsDefaultsToHomeAndSupportsOverride(t *testing.T) {
	unsetAllowedRoots(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	resolvedHome, err := resolvedPath(home)
	if err != nil {
		t.Fatal(err)
	}
	roots, err := configuredAllowedRoots()
	if err != nil || len(roots) != 1 || roots[0] != resolvedHome {
		t.Fatalf("default roots=%v err=%v, want home %q", roots, err, resolvedHome)
	}
	if err := NewEngine(nil, nil, runtime.NewFake()).pathAllowed(nil, home, false); err != nil {
		t.Fatalf("default home root rejected: %v", err)
	}

	explicit := t.TempDir()
	resolvedExplicit, err := resolvedPath(explicit)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", explicit)
	roots, err = configuredAllowedRoots()
	if err != nil || len(roots) != 1 || roots[0] != resolvedExplicit {
		t.Fatalf("explicit roots=%v err=%v, want %q", roots, err, resolvedExplicit)
	}

	t.Setenv("PAIRFOB_ALLOWED_ROOTS", "")
	roots, err = configuredAllowedRoots()
	if err != nil || len(roots) != 0 {
		t.Fatalf("explicit empty roots=%v err=%v, want no configured roots", roots, err)
	}
}

func TestPathAllowedUsesLivePaneCWDWhenWorkspaceCWDIsAbsent(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	outside := t.TempDir()
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", "")
	fake := runtime.NewFake()
	fake.Snap.Workspaces[0].Cwd = ""
	fake.Snap.Panes[0].Cwd = project
	engine := NewEngine(nil, nil, fake)
	if err := engine.pathAllowed(nil, filepath.Join(project, "new"), false); err != nil {
		t.Fatalf("live pane child rejected: %v", err)
	}
	if err := engine.pathAllowed(nil, outside, false); err == nil {
		t.Fatal("path outside the live pane cwd was accepted")
	}
}

func TestPathAllowedResolvesSymlinksAndExplicitRoots(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "project")
	outside := t.TempDir()
	if err := os.Mkdir(project, 0o700); err != nil {
		t.Fatal(err)
	}
	fake := runtime.NewFake()
	fake.Snap.Workspaces[0].Cwd = project
	engine := NewEngine(nil, nil, fake)
	if err := engine.pathAllowed(nil, filepath.Join(project, "new"), false); err != nil {
		t.Fatalf("workspace child rejected: %v", err)
	}
	link := filepath.Join(project, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if err := engine.pathAllowed(nil, filepath.Join(link, "secret"), false); err == nil {
		t.Fatal("symlink escape was accepted")
	}
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", outside)
	if err := ValidateAllowedRoots(); err != nil {
		t.Fatal(err)
	}
	if err := engine.pathAllowed(nil, filepath.Join(outside, "allowed"), false); err != nil {
		t.Fatalf("configured root rejected: %v", err)
	}
}

func TestValidateAllowedRootsFailsClosed(t *testing.T) {
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", "relative-root")
	if err := ValidateAllowedRoots(); err == nil {
		t.Fatal("relative allowlist root was accepted")
	}
	t.Setenv("PAIRFOB_ALLOWED_ROOTS", filepath.Join(t.TempDir(), "missing"))
	if err := ValidateAllowedRoots(); err == nil {
		t.Fatal("missing allowlist root was accepted")
	}
}
