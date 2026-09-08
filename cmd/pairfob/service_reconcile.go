package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"pairfob/internal/admin"
)

const serviceReadyTimeout = 30 * time.Second
const serviceStableFor = time.Second

func ensureInstalledService(layout serviceLayout, force bool) error {
	return withServiceLock(layout, func() error { return reconcileInstalledService(layout, force, version, func() {}) })
}

func reconcileInstalledService(layout serviceLayout, force bool, wantVersion string, beforeStart func()) error {
	if _, err := os.Stat(layout.UnitPath); err != nil {
		return fmt.Errorf("service is not installed; run pairfob service install: %w", err)
	}
	want, err := executableHash(layout.ExecPath)
	if err != nil {
		return err
	}
	sock, err := admin.SocketPathIn(layout.StateDir)
	if err != nil {
		return err
	}
	status, err := observeService(layout)
	if err != nil {
		return err
	}
	if err := verifyServiceTarget(status, layout); err != nil {
		return err
	}
	process, err := inspectLocalProcess(sock)
	if err != nil && !errors.Is(err, admin.ErrNotRunning) {
		return fmt.Errorf("cannot inspect current daemon; leaving it running: %w", err)
	}
	if process != nil {
		defer process.peer.Close()
		if !process.legacy {
			if err := processBelongsTo(process.info, layout); err != nil {
				return err
			}
			if !force && status.State == "running" && status.PID == process.info.PID && process.info.SHA256 == want && process.info.Version == wantVersion {
				beforeStart()
				return waitForService(layout, sock, want, wantVersion)
			}
		}
	}
	if err := pauseUserService(layout, status); err != nil {
		return err
	}
	if process != nil && process.peer.PID == status.PID {
		if err := waitForProcessExit(process.peer.PID); err != nil {
			return err
		}
	}
	if process != nil {
		if err := stopLocalProcess(sock, process, layout); err != nil {
			return err
		}
		if err := waitForProcessExit(process.peer.PID); err != nil {
			return err
		}
		if err := waitForSocketExit(sock); err != nil {
			return err
		}
	}
	// The predecessor is gone. Release the download lock before a new daemon
	// reads its update journal; otherwise a previous phone-update journal makes
	// that startup fail with "another updater is running".
	beforeStart()
	action := "start"
	if layout.GOOS == "darwin" {
		action = "install"
	}
	if err := applyService(layout, action); err != nil {
		return err
	}
	return waitForService(layout, sock, want, wantVersion)
}

// A closed listener is not proof that deferred state writes have finished.
// Signal 0 only observes existence; it never signals a potentially reused PID.
// PID reuse can cause a safe timeout, never termination of a successor.
func waitForProcessExit(pid int) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("daemon PID %d has not exited; inspect it before restarting", pid)
}

func pauseUserService(layout serviceLayout, status serviceObservation) error {
	if layout.GOOS == "darwin" && status.State == "stopped" {
		return nil
	}
	return applyService(layout, "stop")
}

func waitForSocketExit(sock string) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		peer, err := admin.OpenPeer(sock)
		if errors.Is(err, admin.ErrNotRunning) {
			return nil
		}
		if err != nil {
			return err
		}
		peer.Close()
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("daemon did not release its socket; inspect the running process before retrying")
}

func waitForService(layout serviceLayout, sock, want, wantVersion string) error {
	return waitForServiceWithin(layout, sock, want, wantVersion, serviceReadyTimeout, serviceStableFor)
}

func waitForServiceWithin(layout serviceLayout, sock, want, wantVersion string, timeout, stableFor time.Duration) error {
	deadline := time.Now().Add(timeout)
	var stableSince time.Time
	instance := ""
	last := "not answering"
	for time.Now().Before(deadline) {
		status, err := observeService(layout)
		if err != nil {
			return err
		}
		if status.State == "running" && status.PID > 0 {
			if err := verifyServiceTarget(status, layout); err != nil {
				return err
			}
			p, err := inspectLocalProcess(sock)
			if err == nil {
				p.peer.Close()
				if !p.legacy && p.info.PID == status.PID && p.info.SHA256 == want && p.info.Version == wantVersion && processBelongsTo(p.info, layout) == nil {
					if instance != p.info.Instance {
						instance = p.info.Instance
						stableSince = time.Now()
					}
					if time.Since(stableSince) >= stableFor {
						current, err := executableHash(layout.ExecPath)
						if err != nil {
							return err
						}
						if current != want {
							return errors.New("installed executable changed during startup verification")
						}
						return nil
					}
					time.Sleep(200 * time.Millisecond)
					continue
				}
				last = "service PID, running image/version, or socket owner does not match the expected instance"
			} else {
				last = err.Error()
			}
		} else {
			last = status.Detail
		}
		instance = ""
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("service did not become ready: %s; inspect %s", last, layout.LogPath)
}
