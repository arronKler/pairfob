package main

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstallHerdrPreflightAndReadiness(t *testing.T) {
	for _, tc := range []struct {
		name                                          string
		setupFails, doctorFails, skip, relativePrefix bool
	}{
		{name: "ready"}, {name: "relative prefix", relativePrefix: true}, {name: "preflight failure", setupFails: true}, {name: "final readiness failure", doctorFails: true}, {name: "explicit skip", skip: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix := t.TempDir()
			callerDir := t.TempDir()
			prefixArg := prefix
			if tc.relativePrefix {
				prefix = filepath.Join(callerDir, "bin")
				prefixArg = "./bin"
				if err := os.Mkdir(prefix, 0700); err != nil {
					t.Fatal(err)
				}
			}
			startupLog := filepath.Join(t.TempDir(), "startup")
			testHome := t.TempDir()
			log := filepath.Join(t.TempDir(), "calls")
			old := []byte("old installation")
			if err := os.WriteFile(filepath.Join(prefix, "pairfob"), old, 0700); err != nil {
				t.Fatal(err)
			}
			payload := []byte(`#!/bin/sh
printf '%s\n' "$*" >> "$PAIRFOB_TEST_SETUP_LOG"
case "$1" in
 setup) pwd -P > "$PAIRFOB_TEST_STARTUP_LOG"; [ "$PAIRFOB_TEST_SETUP_FAIL" != 1 ] ;;
 doctor) [ "$PAIRFOB_TEST_DOCTOR_FAIL" != 1 ] ;;
 *) exit 0 ;;
esac
`)
			name := artifactName(runtime.GOOS, runtime.GOARCH)
			payload = installerFixturePayload(payload)
			server := httptest.NewServer(updateFixture(name, "test", payload))
			defer server.Close()
			args := []string{filepath.Join(repoRoot(t), "scripts/install.sh"), "--prefix", prefixArg, "--install-herdr", "--non-interactive"}
			if tc.skip {
				args = append(args, "--skip-herdr-check")
			}
			cmd := exec.Command("sh", args...)
			cmd.Dir = callerDir
			flag := func(b bool) string {
				if b {
					return "1"
				}
				return "0"
			}
			cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "HOME="+testHome, "PAIRFOB_TEST_STARTUP_LOG="+startupLog, "PAIRFOB_TEST_SETUP_LOG="+log, "PAIRFOB_TEST_SETUP_FAIL="+flag(tc.setupFails), "PAIRFOB_TEST_DOCTOR_FAIL="+flag(tc.doctorFails))
			out, err := cmd.CombinedOutput()
			calls, _ := os.ReadFile(log)
			if !tc.setupFails {
				got, readErr := os.ReadFile(filepath.Join(prefix, "pairfob"))
				if readErr != nil || string(got) != string(payload) {
					t.Fatalf("installer used wrong prefix: %v", readErr)
				}
			}
			if !tc.skip {
				got, _ := os.ReadFile(startupLog)
				physicalHome, _ := filepath.EvalSymlinks(testHome)
				if strings.TrimSpace(string(got)) != physicalHome {
					t.Fatalf("startup cwd=%q want %s", got, physicalHome)
				}
			}

			if (err != nil) != (tc.setupFails || tc.doctorFails) {
				t.Fatalf("err=%v out=%s", err, out)
			}
			if tc.setupFails {
				got, _ := os.ReadFile(filepath.Join(prefix, "pairfob"))
				if string(got) != string(old) || string(calls) != "setup --install-herdr --non-interactive\n" {
					t.Fatalf("preflight changed installation: %q %s", got, calls)
				}
			} else if tc.skip {
				if strings.Contains(string(calls), "setup") || strings.Contains(string(out), "ready.") || strings.Contains(string(out), "Scan or type") {
					t.Fatalf("skip claimed ready: %s %s", calls, out)
				}
			} else {
				lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
				if len(lines) != 5 || lines[0] != "setup --install-herdr --non-interactive" || !strings.HasPrefix(lines[1], "service prepare-install ") || strings.Join(lines[2:], "\n") != "enroll\nservice install\ndoctor" {
					t.Fatalf("calls %q", calls)
				}
				prepared := strings.TrimPrefix(lines[1], "service prepare-install ")
				gotPath, _ := filepath.EvalSymlinks(prepared)
				wantPath, _ := filepath.EvalSymlinks(filepath.Join(prefix, "pairfob"))
				if gotPath != wantPath {
					t.Fatalf("prepared wrong target: %s", prepared)
				}
				if tc.doctorFails && strings.Contains(string(out), "Scan or type") {
					t.Fatalf("pairing offered while unhealthy: %s", out)
				}
				if !tc.doctorFails && !strings.Contains(string(out), "Pairfob and Herdr are ready.") {
					t.Fatalf("out=%s", out)
				}
			}
		})
	}
}
