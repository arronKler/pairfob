package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestChecksumForAcceptsStarPrefix(t *testing.T) {
	sum := sha256Hex([]byte("bin"))
	got, err := checksumFor(sum+" *pairfob-darwin-arm64\n", "pairfob-darwin-arm64")
	if err != nil || got != sum {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestAllowedDownloadBaseRejectsCleartextInternet(t *testing.T) {
	if err := allowedDownloadBase("http://example.com/dl"); err == nil {
		t.Fatal("expected error")
	}
	if err := allowedDownloadBase("https://pairfob.com/dl"); err != nil {
		t.Fatal(err)
	}
	if err := allowedDownloadBase("http://127.0.0.1:9/dl"); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateExecutableReplacesAndVerifies(t *testing.T) {
	dir := t.TempDir()
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	dest := filepath.Join(dir, "pairfob")
	if err := os.WriteFile(dest, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	fresh := []byte("new-binary-contents")
	server := httptest.NewServer(updateFixture(name, "0.9.0", fresh))
	t.Cleanup(server.Close)
	if err := updateExecutable(dest, server.URL); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(fresh) {
		t.Fatalf("got %q", got)
	}
	if err := updateExecutable(dest, server.URL); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateExecutableRejectsHashMismatch(t *testing.T) {
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	mux := http.NewServeMux()
	mux.HandleFunc("/VERSION", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("1")) })
	mux.HandleFunc("/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("0", 64) + "  " + name + "\n"))
	})
	mux.HandleFunc("/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("payload")) })
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	err := updateExecutable(filepath.Join(t.TempDir(), "pairfob"), server.URL)
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("got %v", err)
	}
}

func updateFixture(name, version string, payload []byte) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/VERSION", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(version + "\n")) })
	mux.HandleFunc("/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(sha256Hex(payload) + "  " + name + "\n"))
	})
	mux.HandleFunc("/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(payload) })
	return mux
}
