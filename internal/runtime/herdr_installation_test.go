package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestHerdrInstallationDiagnosis(t *testing.T) {
	for _, tc := range []struct {
		name            string
		protocol        int
		live, badBinary bool
		want            string
	}{
		{"ready", 20, true, false, "ready"},
		{"old server", 18, true, false, "incompatible"},
		{"stopped", 0, false, false, "stopped"},
		{"invalid executable", 0, false, true, "unavailable"},
		{"live server without usable CLI", 20, true, true, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			socket := shortTestSocket(t)
			if tc.live {
				startScriptedHerdrAt(t, socket, func(req scriptedRequest) scriptedReply {
					reply := standardReply(req)
					if req.Method == "session.snapshot" {
						result := reply.Result.(map[string]any)
						result["snapshot"].(map[string]any)["protocol"] = tc.protocol
					}
					return reply
				})
			}
			h := NewHerdr(socket)
			h.TerminalBinary = writeTerminalFixture(t, "exit 0\n")
			if tc.badBinary {
				h.TerminalBinary = filepath.Join(t.TempDir(), "absent")
			}
			h.launchServer = func(context.Context, string, string, string) (<-chan error, error) {
				t.Fatal("diagnosis must not start Herdr")
				return nil, nil
			}
			if got := h.CheckInstallation(context.Background()); got.State != tc.want {
				t.Fatalf("got %+v, want %s", got, tc.want)
			}
		})
	}
}

func TestHerdrBinaryExplicitFailureDoesNotFallBack(t *testing.T) {
	for _, tc := range []string{"absent", "not-executable", "directory"} {
		t.Run(tc, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc)
			if tc == "not-executable" {
				if err := os.WriteFile(path, []byte("x"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if tc == "directory" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("HERDR_BIN", path)
			if _, err := resolveHerdrBinary(""); err == nil {
				t.Fatal("invalid override silently accepted")
			}
		})
	}
	if got := binaryInstallationFailure(errHerdrNotFound); got.State != "missing" {
		t.Fatalf("%+v", got)
	}
	if got := binaryInstallationFailure(errors.New("permission denied")); got.State != "unavailable" {
		t.Fatalf("%+v", got)
	}
}

func TestHerdrInstallationMissingUsesWrappedNotFound(t *testing.T) {
	h := NewHerdr(shortTestSocket(t))
	h.lookupBinary = func(string) (string, error) { return findHerdrCandidate([]string{filepath.Join(t.TempDir(), "herdr")}) }
	got := h.CheckInstallation(context.Background())
	if got.State != "missing" || !errors.Is(got.Cause, errHerdrNotFound) {
		t.Fatalf("missing installation=%+v", got)
	}
}

func TestHerdrImplicitSearchContinuesPastInvalidCandidates(t *testing.T) {
	for _, kind := range []string{"symlink", "directory", "non-executable"} {
		t.Run(kind, func(t *testing.T) {
			bad := filepath.Join(t.TempDir(), "herdr")
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink("absent", bad)
			case "directory":
				err = os.Mkdir(bad, 0700)
			default:
				err = os.WriteFile(bad, []byte("bad"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			good := writeTerminalFixture(t, "exit 0\n")
			got, err := findHerdrCandidate([]string{bad, good})
			if err != nil || got != good {
				t.Fatalf("got=%s err=%v", got, err)
			}
			// When no valid alternative exists, preserve the incomplete installation.
			if _, err := findHerdrCandidate([]string{bad}); err == nil || errors.Is(err, errHerdrNotFound) {
				t.Fatalf("invalid file should need repair: %v", err)
			}
		})
	}
}

func TestHerdrPathLookupReturnsAbsoluteExecutable(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("HERDR_BIN", "")
	t.Setenv("PATH", "bin")
	t.Setenv("GODEBUG", "execerrdot=0")
	if err := os.Mkdir("bin", 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("bin/herdr", []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.Abs("bin/herdr")
	got, err := ResolveHerdrBinary()
	if err != nil || got != want {
		t.Fatalf("got=%s want=%s err=%v", got, want, err)
	}
}
