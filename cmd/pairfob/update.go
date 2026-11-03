package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	signed "pairfob/internal/release"
)

func updateCommand(args []string) error {
	if len(args) != 0 {
		return errors.New("usage: pairfob update")
	}
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("PAIRFOB_DOWNLOAD_BASE")), "/")
	if base == "" {
		base = defaultDownloadBase
	}
	if err := allowedDownloadBase(base); err != nil {
		return err
	}
	dest, err := resolvedExecutable()
	if err != nil {
		return err
	}
	return updateExecutable(dest, base)
}

func updateExecutable(dest, base string) error {
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	return withServiceLock(layout, func() error { return updateExecutableLocked(dest, base) })
}

func updateExecutableLocked(dest, base string) error {
	unlock, err := lockUpdate(dest)
	if err != nil {
		return err
	}
	var once sync.Once
	release := func() { once.Do(unlock) }
	defer release()
	if _, err := os.Stat(dest + ".update-pending"); !os.IsNotExist(err) {
		return errors.New("a daemon update is awaiting startup verification; try again after it completes")
	}
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	remoteVersion, err := fetchDownloadText(base+"/VERSION", 4096)
	if err != nil {
		return fmt.Errorf("VERSION: %w", err)
	}
	manifest, err := fetchSignedRelease(base, remoteVersion)
	if err != nil {
		return err
	}
	if err := checkManualUpdateVersion(manifest.Version, version); err != nil {
		return err
	}
	want, err := manifest.Hash("daemon/" + name)
	if err != nil {
		return err
	}
	current, err := os.ReadFile(dest)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && sha256Hex(current) == want {
		if err := restartInstalledServiceFor(dest, remoteVersion, release); err != nil {
			return fmt.Errorf("installed files are current (%s), but the running daemon could not be verified: %w", remoteVersion, err)
		}
		fmt.Printf("Already up to date (%s).\n", remoteVersion)
		return nil
	}
	payload, err := fetchDownloadArtifact(base + "/" + name)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if sha256Hex(payload) != want {
		return errors.New("downloaded pairfob failed SHA-256 verification")
	}
	if err := checkDownloadedIdentity(dest, payload, base); err != nil {
		return err
	}
	if err := replaceExecutable(dest, payload); err != nil {
		return err
	}
	if err := restartInstalledServiceFor(dest, remoteVersion, release); err != nil {
		return fmt.Errorf("installed %s, but could not restart Pairfob: %w; start Pairfob again to use it", remoteVersion, err)
	}
	fmt.Printf("Updated to %s.\n", remoteVersion)
	return nil
}

// checkManualUpdateVersion refuses a signed release older than the running
// binary, so a replayed release.json and VERSION cannot downgrade an
// installation. Equal versions stay installable so a damaged binary can be
// repaired, and a development build (version "dev" or empty) has no release
// line to compare against.
func checkManualUpdateVersion(remote, current string) error {
	if !releaseVersion.MatchString(remote) || !releaseVersion.MatchString(current) {
		return nil
	}
	if sameReleaseVersion(remote, current) || newerVersion(remote, current) {
		return nil
	}
	return fmt.Errorf("refusing to downgrade pairfob from %s to %s", current, remote)
}

// sameReleaseVersion compares release versions while tolerating the optional
// leading "v" that release.sh accepts for tags and VERSION files.
func sameReleaseVersion(a, b string) bool {
	return strings.TrimPrefix(a, "v") == strings.TrimPrefix(b, "v")
}

func restartInstalledServiceFor(dest, wantVersion string, release func()) error {
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	if _, err := os.Stat(layout.UnitPath); err != nil {
		return err
	}
	got, err := filepath.EvalSymlinks(dest)
	if err != nil {
		got = dest
	}
	if filepath.Clean(layout.ExecPath) != filepath.Clean(got) {
		return errors.New("installed service is a different binary")
	}
	return reconcileInstalledService(layout, false, wantVersion, release)
}

func allowedDownloadBase(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return errors.New("PAIRFOB_DOWNLOAD_BASE must be an http(s) origin path")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		host := u.Hostname()
		if host == "127.0.0.1" || host == "localhost" || host == "::1" {
			return nil
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("PAIRFOB_DOWNLOAD_BASE must be https (http is only allowed on loopback)")
}

// fetchSignedRelease reads and verifies the signed release manifest. The
// manifest's version must equal the VERSION already fetched, so an older
// signed inventory cannot be paired with a newer version.
func fetchSignedRelease(base, expectedVersion string) (signed.Manifest, error) {
	manifestBytes, err := fetchDownloadBytes(base+"/release.json", 1<<20, downloadPolicy{timeout: updateMetadataTimeout, attempts: 1})
	if err != nil {
		return signed.Manifest{}, fmt.Errorf("release.json: %w", err)
	}
	signature, err := fetchDownloadText(base+"/release.json.sig", 4096)
	if err != nil {
		return signed.Manifest{}, fmt.Errorf("release.json.sig: %w", err)
	}
	if err := signed.Verify(manifestBytes, []byte(signature)); err != nil {
		return signed.Manifest{}, err
	}
	return signed.ParseManifest(manifestBytes, expectedVersion)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func replaceExecutable(dest string, payload []byte) error {
	dir := filepath.Dir(dest)
	tmp, err := os.CreateTemp(dir, ".pairfob-update-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o755); err != nil {
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return err
	}
	ok = true
	return os.Chmod(dest, 0o755)
}
