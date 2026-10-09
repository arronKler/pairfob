package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/admin"
)

func TestNotRunningUsesServiceHintAndPreservesOtherErrors(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
	layout, err := currentServiceLayout()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(layout.UnitPath), 0700); err != nil {
		t.Fatal(err)
	}
	calls := 0
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		calls++
		return fakeManagerOutput(layout, 42), nil
	})
	for _, test := range []struct {
		name, command string
		installed     bool
	}{
		{"absent", "pairfob service install", false},
		{"running but not answering", "pairfob service restart", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.installed {
				if err := os.WriteFile(layout.UnitPath, []byte("unit"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			for _, failure := range []error{admin.ErrNotRunning, fmt.Errorf("admin call: %w", admin.ErrNotRunning)} {
				got := notRunning(failure)
				if got == nil || !strings.Contains(got.Error(), "isn't running") || !strings.Contains(got.Error(), test.command) {
					t.Fatalf("got %v; want not-running advice with %q", got, test.command)
				}
			}
		})
	}
	observations := calls
	other := errors.New("other failure")
	if notRunning(other) != other || notRunning(nil) != nil || calls != observations {
		t.Fatal("non-not-running errors changed or queried the service")
	}
}

func TestRunRejectsExtraArgs(t *testing.T) {
	err := runCommand([]string{"run", "extra"}, testSocket(t))
	if err == nil || err.Error() != "usage: pairfob run" {
		t.Fatalf("got %v", err)
	}
}
