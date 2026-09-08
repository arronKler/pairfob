package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"pairfob/internal/admin"
)

func canonicalInstallTarget(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("installation target must be absolute")
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

// Called by both the verified installer candidate and service install, before
// replacing a binary or service definition. State and pairing files stay put.
func prepareServiceInstall(layout serviceLayout) error {
	sock, err := admin.SocketPathIn(layout.StateDir)
	if err != nil {
		return err
	}
	p, err := inspectLocalProcess(sock)
	if err != nil && !errors.Is(err, admin.ErrNotRunning) {
		return err
	}
	if p != nil {
		defer p.peer.Close()
		if !p.legacy {
			if err := processBelongsTo(p.info, layout); err != nil {
				return err
			}
		}
	}
	_, unitErr := os.Stat(layout.UnitPath)
	if unitErr != nil && !errors.Is(unitErr, os.ErrNotExist) {
		return unitErr
	}
	if unitErr == nil {
		status, err := observeService(layout)
		if err != nil {
			return err
		}
		if err := verifyServiceTarget(status, layout); err != nil {
			return err
		}
		if err := pauseUserService(layout, status); err != nil {
			return err
		}
		if p != nil && p.peer.PID == status.PID {
			if err := waitForProcessExit(p.peer.PID); err != nil {
				return err
			}
		}
	}
	if p != nil {
		if err := stopLocalProcess(sock, p, layout); err != nil {
			return fmt.Errorf("installation stopped before replacement: %w", err)
		}
		if err := waitForProcessExit(p.peer.PID); err != nil {
			return err
		}
		if err := waitForSocketExit(sock); err != nil {
			return err
		}
	}
	return nil
}
