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
	payload := []byte("#!/bin/sh\necho pairfobd-fixture\n")
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	prefix := t.TempDir()
	cmd := exec.Command("sh", script, "--no-service", "--no-enroll", "--prefix", prefix)
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	dest := filepath.Join(prefix, "pairfobd")
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
}

func TestInstallScriptEnrollsWithoutOptionalArgs(t *testing.T) {
	script := filepath.Join(repoRoot(t), "scripts", "install.sh")
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("#!/bin/sh\nprintf 'pairfobd-fixture'\nprintf ' <%s>' \"$@\"\nprintf '\\n'\n")
	server := httptest.NewServer(updateFixture(name, "test", payload))
	t.Cleanup(server.Close)

	cmd := exec.Command("sh", script, "--no-service", "--prefix", t.TempDir())
	cmd.Env = append(os.Environ(), "PAIRFOB_DOWNLOAD_BASE="+server.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "pairfobd-fixture <enroll>") {
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

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}
