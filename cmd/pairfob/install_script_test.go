package main

import (
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

func TestInstallScriptReinstallRemovesLegacyService(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\necho pairfob-fixture\n")
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	legacyLog := filepath.Join(t.TempDir(), "legacy.log")
	legacy := []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >\"$PAIRFOB_TEST_LEGACY_LOG\"\n")
	if err := os.WriteFile(filepath.Join(prefix, "pairfobd"), legacy, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL, "PAIRFOB_TEST_LEGACY_LOG="+legacyLog)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	called, err := os.ReadFile(legacyLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(called) != "service uninstall\n" {
		t.Fatalf("legacy call=%q", called)
	}
	target, err := os.Readlink(filepath.Join(prefix, "pairfobd"))
	if err != nil || target != "pairfob" {
		t.Fatalf("alias target=%q err=%v", target, err)
	}
}

func TestInstallScriptReinstallRemovesCurrentAndLegacyServices(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\necho pairfob-fixture\n")
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	serviceLog := filepath.Join(t.TempDir(), "services.log")
	installed := []byte("#!/bin/sh\nprintf '%s %s\\n' \"$(basename \"$0\")\" \"$*\" >>\"$PAIRFOB_TEST_SERVICE_LOG\"\n")
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
	if string(called) != "pairfob service uninstall\npairfobd service uninstall\n" {
		t.Fatalf("service calls=%q", called)
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
