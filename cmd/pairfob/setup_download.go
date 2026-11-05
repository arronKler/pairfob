package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	runtimeapi "pairfob/internal/runtime"
	"path/filepath"
	"runtime"
)

func installHerdrLocked(f herdrFiles) error {
	if err := f.recoverInstall(); err != nil {
		return err
	}
	// Another installer may have completed while setup was checking readiness.
	if _, err := runtimeapi.ResolveHerdrBinary(); err == nil {
		return nil
	}
	release, err := latestHerdrRelease(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	payload, err := fetchHerdrArtifact(release.URL)
	if err != nil {
		return err
	}
	return installHerdrRelease(f, release, payload)
}

func validateHerdrCandidate(dir string, release herdrRelease, payload []byte) error {
	if sha256Hex(payload) != release.SHA256 {
		return fmt.Errorf("Herdr SHA-256 mismatch; nothing installed")
	}
	tmp, err := os.CreateTemp(dir, ".herdr-check-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err = tmp.Write(payload); err != nil {
		return err
	}
	if err = tmp.Chmod(0700); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	version, err := herdrBinaryVersion(tmp.Name())
	if err != nil {
		return err
	}
	if version != release.Version {
		return fmt.Errorf("Herdr executable version %s does not match manifest %s", version, release.Version)
	}
	return nil
}

func installHerdrRelease(f herdrFiles, release herdrRelease, payload []byte) error {
	if err := validateHerdrCandidate(filepath.Dir(f.target), release, payload); err != nil {
		return err
	}
	receipt, err := newHerdrReceipt(f.target, release)
	if err != nil {
		return err
	}
	if err = writeHerdrJSON(f.path("transaction.json"), herdrTransaction{Phase: "installing", Next: receipt}); err != nil {
		return err
	}
	if err = activateHerdr(f.target, payload, release.SHA256); err != nil {
		return err
	}
	if err = f.recoverInstall(); err != nil {
		return err
	}
	fmt.Printf("Installed Herdr %s (SHA-256 verified) at %s\n", release.Version, f.target)
	return nil
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
