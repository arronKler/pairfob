package main

import (
	"os"
	"sync"
	"syscall"
	"time"
)

// Caller must own the admin listener before touching another boot's journal.
// CLI invocations never call this, including candidate version probes.
func beginUpdateBoot(dir string) (func() error, error) {
	u := &remoteUpdater{dir: dir}
	data, err := os.ReadFile(u.jobPath())
	if os.IsNotExist(err) {
		return func() error { return nil }, nil
	}
	if err != nil {
		return nil, err
	}
	if err = u.load(data); err != nil {
		return nil, err
	}
	u.dest, err = resolvedExecutable()
	if err != nil {
		return nil, err
	}
	unlock, err := lockUpdate(u.dest)
	if err != nil {
		return nil, err
	}
	if u.job.Phase != "restarting" && u.job.Phase != "verifying" {
		defer unlock()
		return func() error { return nil }, u.clearPending()
	}
	rollback := func() {
		if err := u.restoreBackup(); err != nil {
			os.Exit(1)
		}
		_ = syscall.Exec(u.dest, []string{u.dest}, os.Environ())
		os.Exit(1)
	}
	if u.job.Phase == "verifying" {
		rollback()
	}
	if version != u.job.Target {
		defer unlock()
		u.job.Phase = "failed"
		if err = u.save(); err != nil {
			return nil, err
		}
		return func() error { return nil }, u.clearPending()
	}
	u.job.Phase = "verifying"
	if err = u.save(); err != nil {
		unlock()
		return nil, err
	}
	var mu sync.Mutex
	settled := false
	timer := time.AfterFunc(60*time.Second, func() {
		mu.Lock()
		defer mu.Unlock()
		if !settled {
			rollback()
		}
	})
	return func() error {
		mu.Lock()
		defer mu.Unlock()
		if settled {
			return nil
		}
		u.job.Phase = "complete"
		if err := u.save(); err != nil {
			u.job.Phase = "verifying"
			return err
		}
		if err := u.clearPending(); err != nil {
			return err
		}
		settled = true
		timer.Stop()
		unlock()
		return nil
	}, nil
}
