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

func TestInstallerOffersDesktopFromInstalledService(t *testing.T) {
	payload := installerFixturePayload([]byte("#!/bin/sh\nprintf '%s %s\\n' \"$0\" \"$*\" >> \"$PAIRFOB_TEST_CALLS\"\n"))
	srv := httptest.NewServer(updateFixture(artifactName(runtime.GOOS, runtime.GOARCH), "v1.2.3", payload))
	defer srv.Close()
	for _, tc := range []struct {
		name  string
		extra []string
		offer bool
	}{
		{"interactive", nil, runtime.GOOS == "darwin"}, {"unattended", []string{"--non-interactive"}, false}, {"no-service", []string{"--no-service"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prefix := t.TempDir()
			calls := filepath.Join(prefix, "calls")
			args := []string{filepath.Join(repoRoot(t), "scripts/install.sh"), "--prefix", prefix, "--no-enroll", "--skip-runtime-check"}
			cmd := exec.Command("sh", append(args, tc.extra...)...)
			cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+srv.URL, "PAIRFOB_TEST_CALLS="+calls)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			content, err := os.ReadFile(calls)
			if err != nil {
				t.Fatal(err)
			}
			log := string(content)
			offer := strings.Index(log, filepath.Join(prefix, "pairfob")+" desktop setup --if-unconfigured")
			if (offer >= 0) != tc.offer {
				t.Fatal(log)
			}
			if tc.offer {
				installed := strings.Index(log, filepath.Join(prefix, "pairfob")+" service install")
				if installed < 0 || installed >= offer {
					t.Fatal(log)
				}
			}
		})
	}
}
