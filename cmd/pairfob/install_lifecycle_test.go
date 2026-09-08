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

// Installer shell fixtures delegate the transaction wrapper to the requested
// shell. Real advisory-lock inheritance is covered by service_lock_test.go.
func installerFixturePayload(payload []byte) []byte {
	return []byte(strings.Replace(string(payload), "#!/bin/sh\n", "#!/bin/sh\nif [ \"$1 $2\" = 'service with-install-lock' ]; then shift 2; exec \"$@\"; fi\n", 1))
}

func TestInstallerLifecycleFailuresDoNotClaimReady(t *testing.T) {
	for _, phase := range []string{"prepare-install", "install"} {
		t.Run(phase, func(t *testing.T) {
			prefix := t.TempDir()
			old := []byte("old installed binary")
			dest := filepath.Join(prefix, "pairfob")
			os.WriteFile(dest, old, 0700)
			payload := []byte("#!/bin/sh\nif [ \"$1\" = service ] && [ \"$2\" = \"$PAIRFOB_TEST_FAIL_PHASE\" ]; then echo 'cannot verify runtime' >&2; exit 42; fi\nexit 0\n")
			payload = installerFixturePayload(payload)
			server := httptest.NewServer(updateFixture(artifactName(runtime.GOOS, runtime.GOARCH), "v1.1.1", payload))
			defer server.Close()
			cmd := exec.Command("sh", filepath.Join(repoRoot(t), "scripts/install.sh"), "--skip-herdr-check", "--no-enroll", "--prefix", prefix)
			cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_FAIL_PHASE="+phase)
			out, err := cmd.CombinedOutput()
			if err == nil || strings.Contains(string(out), "Pairfob is running") || strings.Contains(string(out), "Installation complete") {
				t.Fatalf("%s %v", out, err)
			}
			if phase == "prepare-install" {
				got, _ := os.ReadFile(dest)
				if string(got) != string(old) {
					t.Fatal("failed preflight replaced installed binary")
				}
			}
		})
	}
}
