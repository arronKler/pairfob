package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstallScriptDownloadsVerifiesAndInstalls(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	if _, err := os.Stat(script); err != nil {
		t.Fatal(err)
	}
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\necho pairfob-fixture\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	cmd := exec.Command("sh", script, "--skip-runtime-check", "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	dest := filepath.Join(prefix, "pairfob")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("installed %q", got)
	}
	info, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o111 == 0 {
		t.Fatalf("not executable: %s", info.Mode())
	}
	if !strings.Contains(string(out), "installed") {
		t.Fatalf("output=%s", out)
	}
	alias := filepath.Join(prefix, "pairfobd")
	target, err := os.Readlink(alias)
	if err != nil {
		t.Fatalf("read alias: %v", err)
	}
	if target != "pairfob" {
		t.Fatalf("alias target=%q", target)
	}
}

func TestInstallScriptRejectsJoinGrant(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	cmd := exec.Command("sh", script, "--grant", "jg_"+strings.Repeat("ab", 16), "--no-service", "--no-enroll", "--prefix", t.TempDir())
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "join grant") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestInstallScriptEnrollsWithoutOptionalArgs(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nprintf 'pairfob-fixture'\nprintf ' <%s>' \"$@\"\nprintf '\\n'\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	cmd := exec.Command("sh", script, "--skip-herdr-check", "--no-service", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "pairfob-fixture <enroll>") {
		t.Fatalf("output=%s", out)
	}
}

func TestInstallScriptSkipRuntimeCheckLeavesRuntimeUnset(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nif [ \"$1\" = runtime ]; then exit 0; fi\nprintf '%s|%s\\n' \"${PAIRFOB_RUNTIME:-unset}\" \"${PAIRFOB_HC:-unset}\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	serviceLog := filepath.Join(t.TempDir(), "services.log")
	cmd := exec.Command("sh", script, "--skip-runtime-check", "--no-enroll", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_SERVICE_LOG="+serviceLog, "PAIRFOB_RUNTIME=", "PAIRFOB_HC=")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "it will be detected when the service starts") {
		t.Fatalf("missing detection note: %s", out)
	}
	called, err := os.ReadFile(serviceLog)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(called)) == "" {
		t.Fatal("service install did not run")
	}
	for _, line := range strings.Split(strings.TrimSpace(string(called)), "\n") {
		if line != "unset|unset" {
			t.Fatalf("installer guessed a runtime: %q", called)
		}
	}
}

func TestInstallScriptSkipRuntimeCheckPersistsAutoSelectedCore(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nif [ \"$1\" = runtime ]; then printf '{\"kind\":\"herdr-core\"}\\n'; exit 0; fi\nprintf '%s|%s\\n' \"${PAIRFOB_RUNTIME:-unset}\" \"${PAIRFOB_HC:-unset}\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	hcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(hcDir, "hc"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	serviceLog := filepath.Join(t.TempDir(), "services.log")
	cmd := exec.Command("sh", script, "--skip-runtime-check", "--no-enroll", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_SERVICE_LOG="+serviceLog, "PAIRFOB_RUNTIME=", "PAIRFOB_HC=", "PATH="+hcDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	called, err := os.ReadFile(serviceLog)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(called)) == "" {
		t.Fatal("service install did not run")
	}
	want := "core|" + filepath.Join(hcDir, "hc")
	for _, line := range strings.Split(strings.TrimSpace(string(called)), "\n") {
		if line != want {
			t.Fatalf("service environment=%q want %q", called, want)
		}
	}
}

func TestInstallScriptRejectsBadChecksum(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	mux := http.NewServeMux()
	mux.HandleFunc("/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("0", 64) + "  " + name + "\n"))
	})
	mux.HandleFunc("/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("nope")) })
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	cmd := exec.Command("sh", script, "--skip-herdr-check", "--no-service", "--no-enroll", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "SHA-256") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestInstallScriptReinstallMigratesLegacyServiceWithDownloadedBinary(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nif [ \"$1\" = runtime ]; then printf '{\"kind\":\"herdr\"}\\n'; exit 0; fi\nprintf 'downloaded %s\\n' \"$*\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	serviceLog := filepath.Join(t.TempDir(), "services.log")
	legacy := []byte("#!/bin/sh\nexit 41\n")
	if err := os.WriteFile(filepath.Join(prefix, "pairfobd"), legacy, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", script, "--skip-herdr-check", "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_SERVICE_LOG="+serviceLog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	called, err := os.ReadFile(serviceLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(called) != "downloaded service migrate-legacy\ndownloaded service prepare-install "+filepath.Join(prefix, "pairfob")+"\ndownloaded service uninstall\n" {
		t.Fatalf("service calls=%q", called)
	}
	target, err := os.Readlink(filepath.Join(prefix, "pairfobd"))
	if err != nil || target != "pairfob" {
		t.Fatalf("alias target=%q err=%v", target, err)
	}
}

func TestInstallScriptReinstallRemovesCurrentAndLegacyServices(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nif [ \"$1\" = runtime ]; then printf '{\"kind\":\"herdr\"}\\n'; exit 0; fi\nprintf 'downloaded %s\\n' \"$*\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	serviceLog := filepath.Join(t.TempDir(), "services.log")
	installed := []byte("#!/bin/sh\nexit 42\n")
	for _, command := range []string{"pairfob", "pairfobd"} {
		if err := os.WriteFile(filepath.Join(prefix, command), installed, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	cmd := exec.Command("sh", script, "--skip-herdr-check", "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_SERVICE_LOG="+serviceLog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	called, err := os.ReadFile(serviceLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(called) != "downloaded service migrate-legacy\ndownloaded service prepare-install "+filepath.Join(prefix, "pairfob")+"\ndownloaded service uninstall\n" {
		t.Fatalf("service calls=%q", called)
	}
}

func TestInstallScriptKeepsLegacyBinaryWhenMigrationFails(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nif [ \"$*\" = 'service migrate-legacy' ]; then exit 43; fi\n")
	payload = installerFixturePayload(payload)
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	legacyPath := filepath.Join(prefix, "pairfobd")
	legacy := []byte("#!/bin/sh\necho legacy\n")
	if err := os.WriteFile(legacyPath, legacy, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", script, "--skip-herdr-check", "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("install.sh succeeded unexpectedly: %s", out)
	}
	got, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatalf("legacy binary was not preserved: %v", err)
	}
	if string(got) != string(legacy) {
		t.Fatalf("legacy binary changed: %q", got)
	}
	info, err := os.Lstat(legacyPath)
	if err != nil {
		t.Fatalf("stat legacy path: %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("legacy path is no longer a regular file: mode=%v", info.Mode())
	}
	if _, err := os.Stat(filepath.Join(prefix, "pairfob")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new binary was installed after migration failure: %v", err)
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func TestInstallScriptRejectsUnknownRuntime(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	cmd := exec.Command("sh", script, "--runtime", "bogus", "--no-service", "--no-enroll", "--prefix", t.TempDir())
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "--runtime must be auto, herdr, or core") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestInstallScriptRejectsHerdrFlagsForCore(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	for _, flag := range []string{"--install-herdr", "--no-install-herdr"} {
		t.Run(flag, func(t *testing.T) {
			cmd := exec.Command("sh", script, "--runtime", "core", flag, "--no-service", "--no-enroll", "--prefix", t.TempDir())
			out, err := cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "apply only to the Herdr runtime") {
				t.Fatalf("err=%v out=%s", err, out)
			}
		})
	}
}

func TestInstallScriptCoreRequiresHC(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	server := httptest.NewServer(updateFixture(name, "test", installerFixturePayload([]byte("#!/bin/sh\nexit 0\n"))))
	t.Cleanup(server.Close)
	missing := filepath.Join(t.TempDir(), "missing-hc")
	cmd := exec.Command("sh", script, "--runtime", "core", "--no-service", "--no-enroll", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_HC="+missing)
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "needs herdr-core (hc) on PATH") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestInstallScriptCorePrintsHCTerminalWithoutHerdr(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	server := httptest.NewServer(updateFixture(name, "test", installerFixturePayload([]byte("#!/bin/sh\nexit 0\n"))))
	t.Cleanup(server.Close)
	hcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(hcDir, "hc"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", script, "--runtime", "core", "--no-enroll", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_HC=", "PATH="+hcDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	for _, want := range []string{"Local terminal: hc run --bg claude", "terminals started with `hc run`"} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
	if strings.Contains(string(out), "--update-herdr") {
		t.Fatalf("core install offered a Herdr update: %s", out)
	}
}
