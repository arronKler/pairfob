package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Pinned from https://herdr.dev/latest.json, version 0.8.2. Update the version,
// assets and checksums together after compatibility verification.
const bundledHerdrVersion = "0.8.2"

type herdrRelease struct{ asset, sha256 string }

var herdrReleases = map[string]herdrRelease{
	"darwin/arm64": {"herdr-macos-aarch64", "a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574"},
	"darwin/amd64": {"herdr-macos-x86_64", "ab50262c8190cd7aa9056d249d255c08c328c3e8716de9cfa29db4f131b8e2c1"},
	"linux/arm64":  {"herdr-linux-aarch64", "f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d"},
	"linux/amd64":  {"herdr-linux-x86_64", "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4"},
}

func installHerdr() error {
	release, ok := herdrReleases[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return fmt.Errorf("Herdr automatic install is unsupported on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	url := "https://github.com/herdrdev/herdr/releases/download/v" + bundledHerdrVersion + "/" + release.asset
	payload, err := fetchHerdrArtifact(url)
	if err != nil {
		return fmt.Errorf("download Herdr: %w", err)
	}
	return activateHerdr(filepath.Join(home, ".local", "bin", "herdr"), payload, release.sha256)
}

func activateHerdr(dest string, payload []byte, want string) error {
	if fmt.Sprintf("%x", sha256.Sum256(payload)) != want {
		return fmt.Errorf("Herdr SHA-256 mismatch; nothing installed")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(dest), ".herdr-install-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(payload); err != nil {
		return err
	}
	if err = file.Chmod(0755); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	// Link atomically publishes a complete executable without replacing an
	// existing file or symlink, including one installed while downloading.
	if err = os.Link(file.Name(), dest); err != nil {
		return fmt.Errorf("install Herdr without replacing an existing installation: %w", err)
	}
	return nil
}

// GitHub release downloads redirect to its asset host. This policy is local to
// the pinned dependency; origin enrollment and Pairfob updates stay unchanged.
var errHerdrDownloadRedirect = errors.New("Herdr download redirected outside the trusted release host; update Pairfob or install Herdr manually")

func herdrDownloadRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > 3 || req.URL.Scheme != "https" || req.URL.Host != "release-assets.githubusercontent.com" || req.URL.User != nil {
		return errHerdrDownloadRedirect
	}
	return nil
}

func fetchHerdrArtifact(url string) ([]byte, error) {
	client := originHTTPClient(2 * time.Minute)
	client.CheckRedirect = herdrDownloadRedirect
	resp, err := client.Get(url)
	if err != nil {
		if errors.Is(err, errHerdrDownloadRedirect) {
			return nil, errHerdrDownloadRedirect
		}
		return nil, errors.New("could not download Herdr from GitHub; check network access and retry setup")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, downloadStatusError(resp.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxUpdateBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Herdr download: %w", err)
	}
	if len(payload) > maxUpdateBytes {
		return nil, errDownloadTooLarge
	}
	return payload, nil
}
