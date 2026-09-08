package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

const inheritedServiceLock = "PAIRFOB_INSTALL_LOCK_FD"

// Serialize control of the user's one service across update, restart and the
// installer. Daemon startup does not acquire this lock (it has its own image
// update lock), so the controller can keep it through readiness verification.
func openServiceLock(layout serviceLayout) (*os.File, error) {
	path := layout.UnitPath + ".control-lock"
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || sys.Uid != uint32(os.Getuid()) || sys.Nlink != 1 {
		f.Close()
		return nil, errors.New("unsafe service control lock")
	}
	// The verified installer holds one lock across its shell transaction. Nested
	// CLI commands inherit that same open file description at fd 3; validating
	// the inode and flock avoids a string environment flag bypassing the lock.
	if os.Getenv(inheritedServiceLock) == "3" {
		dup, err := unix.Dup(3)
		if err == nil {
			unix.CloseOnExec(dup)
			inherited := os.NewFile(uintptr(dup), path)
			owned, statErr := inherited.Stat()
			if statErr == nil && os.SameFile(st, owned) && unix.Flock(dup, unix.LOCK_EX|unix.LOCK_NB) == nil {
				f.Close()
				return inherited, nil
			}
			inherited.Close()
		}
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another Pairfob install, update or service operation is running; retry after it finishes")
	}
	return f, nil
}

func withServiceLock(layout serviceLayout, action func() error) error {
	f, err := openServiceLock(layout)
	if err != nil {
		return err
	}
	defer f.Close()
	return action()
}

func runInstallerLocked(args []string) error {
	if len(args) == 0 {
		return errors.New("installer command is required")
	}
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	f, err := openServiceLock(layout)
	if err != nil {
		return err
	}
	defer f.Close()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.ExtraFiles = []*os.File{f}
	cmd.Env = append(os.Environ(), inheritedServiceLock+"=3")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}
