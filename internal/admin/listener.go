package admin

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type ownedListener struct {
	*net.UnixListener
	path     string
	identity os.FileInfo
	lock     *os.File
	once     sync.Once
	err      error
}

func (l *ownedListener) Close() error {
	l.once.Do(func() {
		l.err = l.UnixListener.Close()
		if current, err := os.Lstat(l.path); err == nil && os.SameFile(current, l.identity) {
			_ = os.Remove(l.path)
		}
		_ = unix.Flock(int(l.lock.Fd()), unix.LOCK_UN)
		_ = l.lock.Close()
	})
	return l.err
}

func Listen(path string) (net.Listener, error) {
	path, err := validatePath(path)
	if err != nil {
		return nil, err
	}
	fd, err := unix.Open(path+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), path+".lock")
	keep := false
	defer func() {
		if !keep {
			_ = lock.Close()
		}
	}()
	st, err := lock.Stat()
	if err != nil || !safeOwnedFile(st, 0) {
		return nil, errors.New("unsafe admin lock file")
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, errors.New("pairfob already running or starting")
	}
	conn, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return nil, errors.New("pairfob already running")
	}
	if !errors.Is(err, os.ErrNotExist) && !isRefused(err) {
		return nil, fmt.Errorf("cannot inspect existing admin socket: %w", err)
	}
	if st, err := os.Lstat(path); err == nil {
		if !safeOwnedFile(st, os.ModeSocket) {
			return nil, errors.New("unsafe existing admin socket")
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	identity, err := os.Lstat(path)
	if err != nil {
		ln.Close()
		return nil, err
	}
	owned := &ownedListener{UnixListener: ln, path: path, identity: identity, lock: lock}
	keep = true
	if err := os.Chmod(path, 0600); err != nil {
		owned.Close()
		return nil, err
	}
	return owned, nil
}

func safeOwnedFile(info os.FileInfo, kind os.FileMode) bool {
	if info == nil || info.Mode().Type() != kind || info.Mode().Perm()&0077 != 0 {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Uid == uint32(os.Getuid()) && st.Nlink == 1
}
