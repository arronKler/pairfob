package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryHintOnlyObservesService(t *testing.T) {
	for _, platform := range []string{"darwin", "linux"} {
		for _, test := range []struct {
			name, note, command string
		}{
			{"absent", "service not installed", "pairfob service install"},
			{"stopped", "service stopped", "pairfob service start"},
			{"running", "service running but not answering", "pairfob service restart"},
			{"error", "service status unavailable", "pairfob service status"},
		} {
			t.Run(platform+"/"+test.name, func(t *testing.T) {
				layout := serviceLayout{GOOS: platform, UnitPath: filepath.Join(t.TempDir(), "unit"), ExecPath: "/bin/pairfob"}
				unit := []byte("unit sentinel")
				if test.name != "absent" {
					if err := os.WriteFile(layout.UnitPath, unit, 0600); err != nil {
						t.Fatal(err)
					}
				}
				calls := 0
				stubServiceRunner(t, func(args []string) ([]byte, error) {
					calls++
					readOnly := len(args) >= 2 && args[0] == "launchctl" && args[1] == "print"
					if platform == "linux" {
						readOnly = len(args) >= 3 && args[0] == "systemctl" && args[1] == "--user" && args[2] == "show"
					}
					if !readOnly {
						t.Fatalf("recovery hint performed a mutating command: %v", args)
					}
					if test.name == "error" {
						return nil, errors.New("manager unavailable")
					}
					if test.name == "stopped" {
						if platform == "darwin" {
							return []byte("state = waiting\n"), nil
						}
						return fakeManagerOutput(layout, 0), nil
					}
					return fakeManagerOutput(layout, 42), nil
				})
				hint := recoveryHint(layout, nil)
				if hint.Note != test.note || hint.Command != test.command {
					t.Fatalf("got %+v", hint)
				}
				wantCalls := 1
				if test.name == "absent" {
					wantCalls = 0
				} else if got, err := os.ReadFile(layout.UnitPath); err != nil || !bytes.Equal(got, unit) {
					t.Fatalf("unit changed: %q %v", got, err)
				}
				if calls != wantCalls {
					t.Fatalf("observations=%d want=%d", calls, wantCalls)
				}
				entries, err := os.ReadDir(filepath.Dir(layout.UnitPath))
				if err != nil || len(entries) != wantCalls {
					t.Fatalf("unexpected files (including service locks): %v %v", entries, err)
				}
			})
		}
	}
}

func TestRecoveryHintWithoutServiceLayout(t *testing.T) {
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		t.Fatalf("unavailable layout queried service: %v", args)
		return nil, nil
	})
	for _, hint := range []serviceRecoveryHint{
		recoveryHint(serviceLayout{}, errors.New("unsupported OS")),
		recoveryHint(serviceLayout{GOOS: "unsupported"}, nil),
	} {
		if hint.Command != "pairfob run" {
			t.Fatalf("got %+v", hint)
		}
	}
}
