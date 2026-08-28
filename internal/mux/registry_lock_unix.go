//go:build unix

package mux

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func withRegistryLock(statePath string, fn func() error) error {
	if statePath == "" {
		return fn()
	}
	parent := filepath.Dir(statePath)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(statePath+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	defer unix.Flock(int(f.Fd()), unix.LOCK_UN)
	return fn()
}
