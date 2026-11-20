package main

import (
	"os"
	"path/filepath"
	"testing"

	"pairfob/internal/admin"
)

func TestDesktopOfflineDisableTargetsOnlyKnownState(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	t.Setenv("PAIRFOB_STATE_DIR", a)
	const grant = "previous grant"
	for _, dir := range []string{a, b} {
		if err := os.WriteFile(filepath.Join(dir, "desktop-access"), []byte(grant), 0600); err != nil {
			t.Fatal(err)
		}
	}
	wrong, _ := admin.DefaultSocketPathIn(b)
	t.Setenv("PAIRFOB_ADMIN_SOCK", wrong)
	for _, op := range []string{"disable", "status"} {
		if err := desktopCommand(wrong, []string{op}); err == nil {
			t.Fatal(op, "succeeded on ambiguous offline socket")
		}
	}
	for _, dir := range []string{a, b} {
		raw, err := os.ReadFile(filepath.Join(dir, "desktop-access"))
		if err != nil || string(raw) != grant {
			t.Fatal("wrong instance changed", err)
		}
	}
	target, _ := admin.DefaultSocketPathIn(a)
	if err := desktopCommand(target, []string{"disable"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(a, "desktop-access"))
	if err != nil || string(raw) == grant {
		t.Fatal("expected offline disable", err)
	}
}
