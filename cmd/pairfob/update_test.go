package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/release"
)

// updateTestKey is a fixture-only signing key derived from a fixed label. It
// never touches a real release key or $HOME.
var updateTestKey = ed25519.NewKeyFromSeed(func() []byte {
	sum := sha256.Sum256([]byte("pairfob updater tests"))
	return sum[:]
}())

func init() {
	release.PublicKeyHex = hex.EncodeToString(updateTestKey.Public().(ed25519.PublicKey))
}

func TestAllowedDownloadBaseRejectsCleartextInternet(t *testing.T) {
	if err := allowedDownloadBase("http://example.com/dl"); err == nil {
		t.Fatal("expected error")
	}
	if err := allowedDownloadBase("https://pairfob.com/dl"); err != nil {
		t.Fatal(err)
	}
	if err := allowedDownloadBase(defaultDownloadBase); err != nil {
		t.Fatal(err)
	}
	if err := allowedDownloadBase("http://127.0.0.1:9/dl"); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateExecutableReplacesAndVerifies(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	dest := filepath.Join(dir, "pairfob")
	if err := os.WriteFile(dest, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	fresh := []byte("new-binary-contents")
	server := httptest.NewServer(updateFixture(name, "0.9.0", fresh))
	t.Cleanup(server.Close)
	if err := updateExecutable(dest, server.URL); err == nil || !strings.Contains(err.Error(), "could not restart") {
		t.Fatalf("must distinguish installed bytes from running service: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(fresh) {
		t.Fatalf("got %q", got)
	}
	if err := updateExecutable(dest, server.URL); err == nil || !strings.Contains(err.Error(), "running daemon could not be verified") {
		t.Fatalf("matching disk bytes must not bypass runtime verification: %v", err)
	}
}

func TestUpdateExecutableRejectsHashMismatch(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	manifest := updateManifest(name, "1.0.0", []byte("payload"))
	manifest.Files["daemon/"+name] = release.File{SHA256: strings.Repeat("0", 64), Size: 7}
	server := httptest.NewServer(releaseServer("1.0.0", manifest, name, []byte("payload"), false))
	t.Cleanup(server.Close)
	err := updateExecutable(filepath.Join(t.TempDir(), "pairfob"), server.URL)
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdateExecutableRejectsTamperedManifest(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("payload")
	manifest := updateManifest(name, "1.0.0", payload)
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := signUpdate(body)
	body = append([]byte(nil), body...)
	body[len(body)-2] = ' '
	server := httptest.NewServer(releaseHandler("1.0.0", body, signature, name, payload, false))
	t.Cleanup(server.Close)
	err = updateExecutable(filepath.Join(t.TempDir(), "pairfob"), server.URL)
	if err == nil || !strings.Contains(err.Error(), "signature does not match") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdateExecutableRejectsTamperedSignature(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("payload")
	manifest := updateManifest(name, "1.0.0", payload)
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(signUpdate(body))
	if err != nil {
		t.Fatal(err)
	}
	raw[0] ^= 0xff
	tampered := base64.StdEncoding.EncodeToString(raw)
	server := httptest.NewServer(releaseHandler("1.0.0", body, tampered, name, payload, false))
	t.Cleanup(server.Close)
	err = updateExecutable(filepath.Join(t.TempDir(), "pairfob"), server.URL)
	if err == nil || !strings.Contains(err.Error(), "signature does not match") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdateExecutableRejectsVersionMismatch(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	payload := []byte("payload")
	server := httptest.NewServer(releaseServer("1.0.1", updateManifest(name, "1.0.0", payload), name, payload, false))
	t.Cleanup(server.Close)
	err := updateExecutable(filepath.Join(t.TempDir(), "pairfob"), server.URL)
	if err == nil || !strings.Contains(err.Error(), "does not match VERSION") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdateExecutableDoesNotNeedSHA256SUMS(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	dest := filepath.Join(dir, "pairfob")
	if err := os.WriteFile(dest, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	fresh := []byte("new-binary-contents")
	server := httptest.NewServer(updateFixtureWithoutSums(name, "0.9.0", fresh))
	t.Cleanup(server.Close)
	err := updateExecutable(dest, server.URL)
	if err == nil || !strings.Contains(err.Error(), "could not restart") {
		t.Fatalf("SHA256SUMS must not be fetched: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(fresh) {
		t.Fatalf("got %q", got)
	}
}

func TestArtifactDownloadHasASeparateRetryBudget(t *testing.T) {
	if updateArtifactTimeout <= updateMetadataTimeout {
		t.Fatalf("artifact timeout %s must exceed metadata timeout %s", updateArtifactTimeout, updateMetadataTimeout)
	}
	if updateArtifactAttempts < 2 {
		t.Fatalf("artifact attempts=%d", updateArtifactAttempts)
	}
}

func TestDownloadRetriesATimedOutResponseBody(t *testing.T) {
	var requests atomic.Int32
	payload := []byte("complete-binary")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			// Hold the body until the client deadline, independently of scheduling.
			<-r.Context().Done()
			return
		}
		_, _ = w.Write(payload)
	}))
	t.Cleanup(server.Close)

	got, err := fetchDownloadBytes(server.URL, 1024, downloadPolicy{
		timeout:  time.Second,
		attempts: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) || requests.Load() != 2 {
		t.Fatalf("payload=%q requests=%d", got, requests.Load())
	}
}

func TestDownloadDoesNotRetryAPermanentHTTPStatus(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "missing", http.StatusNotFound)
	}))
	t.Cleanup(server.Close)

	_, err := fetchDownloadBytes(server.URL, 1024, downloadPolicy{timeout: time.Second, attempts: 3})
	if err == nil || requests.Load() != 1 {
		t.Fatalf("err=%v requests=%d", err, requests.Load())
	}
}

func updateFixture(name, version string, payload []byte) http.Handler {
	return releaseServer(version, updateManifest(name, version, payload), name, payload, true)
}

func updateFixtureWithoutSums(name, version string, payload []byte) http.Handler {
	return releaseServer(version, updateManifest(name, version, payload), name, payload, false)
}

func updateManifest(name, version string, payload []byte) release.Manifest {
	return release.Manifest{
		Schema:  release.Schema,
		Version: version,
		Commit:  strings.Repeat("a", 40),
		Files: map[string]release.File{
			"daemon/" + name: {SHA256: sha256Hex(payload), Size: int64(len(payload))},
		},
	}
}

func signUpdate(body []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(updateTestKey, body))
}

func releaseServer(version string, manifest release.Manifest, name string, payload []byte, sums bool) http.Handler {
	body, err := json.Marshal(manifest)
	if err != nil {
		panic(err)
	}
	return releaseHandler(version, body, signUpdate(body), name, payload, sums)
}

func releaseHandler(version string, manifest []byte, signature, name string, payload []byte, sums bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/VERSION", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(version + "\n")) })
	mux.HandleFunc("/release.json", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(manifest) })
	mux.HandleFunc("/release.json.sig", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(signature + "\n"))
	})
	if sums {
		mux.HandleFunc("/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(sha256Hex(payload) + "  " + name + "\n"))
		})
	}
	mux.HandleFunc("/"+name, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(payload) })
	return mux
}
