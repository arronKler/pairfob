package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
	"pairfob/internal/admin"
)

// Older daemons do not implement daemon.info/stop. A pidfd pins the process
// against PID reuse; /proc must also prove the expected image, state directory,
// and ownership of the named listening socket. Never fall back to kill(pid).
func stopLegacyProcess(sock string, peer *admin.Peer, layout serviceLayout) error {
	if peer.PID <= 1 || peer.PID == os.Getpid() || peer.UID != uint32(os.Getuid()) {
		return errors.New("invalid legacy daemon PID")
	}
	// No request is sent on this connection: the legacy server keeps it open
	// while we pin and inspect its process, instead of reusing an EOF peer.
	live, err := admin.OpenPeer(sock)
	if errors.Is(err, admin.ErrNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	defer live.Close()
	if live.PID != peer.PID {
		return errors.New("legacy socket owner changed; inspect again")
	}
	fd, err := unix.PidfdOpen(live.PID, 0)
	if errors.Is(err, unix.ESRCH) {
		return nil
	}
	if err != nil {
		return legacyConflict(peer.PID, err)
	}
	defer unix.Close(fd)
	if err := legacyPeerStillOpen(live); err != nil {
		return legacyConflict(peer.PID, err)
	}
	info, err := legacyProcessInfo(peer.PID, sock)
	if err != nil {
		return legacyConflict(peer.PID, err)
	}
	if err := processBelongsTo(info, layout); err != nil {
		return err
	}
	// Reconnect after inspection to reject a replaced listener, then signal the
	// pinned process rather than the numeric PID returned by the fresh connection.
	fresh, err := admin.OpenPeer(sock)
	if errors.Is(err, admin.ErrNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	defer fresh.Close()
	if fresh.PID != peer.PID {
		return errors.New("legacy socket owner changed; inspect again")
	}
	if err := legacyPeerStillOpen(live); err != nil {
		return legacyConflict(peer.PID, err)
	}
	if err := unix.PidfdSendSignal(fd, unix.SIGTERM, nil, 0); err != nil && !errors.Is(err, unix.ESRCH) {
		return err
	}
	return nil
}

func legacyPeerStillOpen(peer *admin.Peer) error {
	raw, err := peer.Conn.SyscallConn()
	if err != nil {
		return err
	}
	var result error
	err = raw.Control(func(fd uintptr) {
		var b [1]byte
		n, _, readErr := unix.Recvfrom(int(fd), b[:], unix.MSG_PEEK|unix.MSG_DONTWAIT)
		if readErr == unix.EAGAIN || readErr == unix.EWOULDBLOCK {
			return
		}
		if readErr != nil {
			result = readErr
			return
		}
		if n == 0 {
			result = errors.New("legacy peer exited during inspection")
		}
	})
	if err != nil {
		return err
	}
	return result
}

func legacyConflict(pid int, err error) error {
	return fmt.Errorf("cannot safely take over legacy Pairfob PID %d: %w; inspect that process and stop it explicitly, then run pairfob service restart", pid, err)
}

func legacyProcessInfo(pid int, sock string) (admin.ProcessInfo, error) {
	base := filepath.Join("/proc", strconv.Itoa(pid))
	st, err := os.Stat(base)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || sys.Uid != uint32(os.Getuid()) {
		return admin.ProcessInfo{}, errors.New("legacy process belongs to another user")
	}
	// SO_PEERCRED already proved the UID. The process's environment is read only
	// to resolve its state directory; no environment values are logged.
	exe, err := os.Readlink(filepath.Join(base, "exe"))
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	exe = strings.TrimSuffix(exe, " (deleted)")
	env, err := readSmallFile(filepath.Join(base, "environ"), 1<<20)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	var home, dir, override string
	for _, item := range bytes.Split(env, []byte{0}) {
		key, value, found := bytes.Cut(item, []byte("="))
		if !found {
			continue
		}
		switch string(key) {
		case "HOME":
			home = string(value)
		case "PAIRFOB_STATE_DIR":
			dir = string(value)
		case "PAIRFOB_ADMIN_SOCK":
			override = string(value)
		}
	}
	if dir == "" {
		if !filepath.IsAbs(home) {
			return admin.ProcessInfo{}, errors.New("legacy HOME is not absolute")
		}
		dir = filepath.Join(home, ".config", "pairfob")
	}
	if !filepath.IsAbs(dir) {
		return admin.ProcessInfo{}, errors.New("legacy state directory is not absolute")
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	expected := override
	if expected == "" {
		expected = filepath.Join(dir, "pairfob.sock")
	}
	actual, err := filepath.EvalSymlinks(sock)
	if err != nil {
		return admin.ProcessInfo{}, err
	}
	expected, err = filepath.EvalSymlinks(expected)
	if err != nil || actual != expected {
		return admin.ProcessInfo{}, errors.New("legacy admin socket does not match its state")
	}
	if err := processOwnsListener(base, actual); err != nil {
		return admin.ProcessInfo{}, err
	}
	return admin.ProcessInfo{PID: pid, Executable: exe, StateDir: dir}, nil
}

func readSmallFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(b)) > limit {
		return nil, errors.New("process metadata is too large")
	}
	return b, err
}

func processOwnsListener(base, sock string) error {
	b, err := readSmallFile(filepath.Join(base, "net/unix"), 8<<20)
	if err != nil {
		return err
	}
	var inode string
	rowPattern := regexp.MustCompile(`^\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+(\S+)\s+(.+)$`)
	for _, row := range strings.Split(string(b), "\n") {
		fields := rowPattern.FindStringSubmatch(row)
		if len(fields) == 4 && fields[1] == "00010000" {
			path, err := filepath.EvalSymlinks(fields[3])
			if err == nil && path == sock {
				inode = fields[2]
				break
			}
		}
	}
	if inode == "" {
		return errors.New("cannot identify legacy listener")
	}
	entries, err := os.ReadDir(filepath.Join(base, "fd"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path, _ := os.Readlink(filepath.Join(base, "fd", entry.Name()))
		if path == "socket:["+inode+"]" {
			return nil
		}
	}
	return errors.New("legacy process does not own the listener")
}
