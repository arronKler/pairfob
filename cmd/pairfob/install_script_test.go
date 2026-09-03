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
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", prefix)
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
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	cmd := exec.Command("sh", script, "--no-service", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "pairfob-fixture <enroll>") {
		t.Fatalf("output=%s", out)
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
	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "SHA-256") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestInstallScriptReinstallMigratesLegacyServiceWithDownloadedBinary(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nprintf 'downloaded %s\\n' \"$*\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	serviceLog := filepath.Join(t.TempDir(), "services.log")
	legacy := []byte("#!/bin/sh\nexit 41\n")
	if err := os.WriteFile(filepath.Join(prefix, "pairfobd"), legacy, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_SERVICE_LOG="+serviceLog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	called, err := os.ReadFile(serviceLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(called) != "downloaded service migrate-legacy\n" {
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
	payload := []byte("#!/bin/sh\nprintf 'downloaded %s\\n' \"$*\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
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

	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_SERVICE_LOG="+serviceLog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	called, err := os.ReadFile(serviceLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(called) != "downloaded service migrate-legacy\ndownloaded service uninstall\n" {
		t.Fatalf("service calls=%q", called)
	}
}

func TestInstallScriptKeepsLegacyBinaryWhenMigrationFails(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nif [ \"$*\" = 'service migrate-legacy' ]; then exit 43; fi\n")
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	legacyPath := filepath.Join(prefix, "pairfobd")
	legacy := []byte("#!/bin/sh\necho legacy\n")
	if err := os.WriteFile(legacyPath, legacy, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", prefix)
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
