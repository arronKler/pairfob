//go:build darwin || linux

package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func localHookDescendsFrom(ctx context.Context, leader int, agent string) bool {
	pid := os.Getpid()
	for depth := 0; depth < 16 && pid > 1; depth++ {
		if pid == leader {
			return true
		}
		cmd := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "ppid=", "-o", "args=")
		data, err := cmd.Output()
		if err != nil {
			return false
		}
		fields := strings.Fields(string(data))
		if len(fields) < 2 {
			return false
		}
		// Nested CLI runs are not the pane's interactive conversation, even
		// when they inherit HERDR_* and are descendants of its foreground job.
		if pid != os.Getpid() && nestedObservationAgent(fields[1:], agent) {
			return false
		}
		parent, err := strconv.Atoi(fields[0])
		if err != nil || parent == pid {
			return false
		}
		pid = parent
	}
	return false
}

func nestedObservationAgent(argv []string, agent string) bool {
	for _, arg := range argv[:min(2, len(argv))] {
		arg = strings.Trim(arg, "\"'")
		base := filepath.Base(arg)
		if agent == "cmd" && (base == "command-code" || base == "commandcode" || strings.Contains(arg, "/command-code/")) {
			return true
		}
		if base == agent || base == agent+".js" || base == agent+".mjs" || base == agent+"-cli" || strings.Contains(arg, "/node_modules/"+agent+"/") || strings.Contains(arg, "/"+agent+"-cli/") {
			return true
		}
	}
	return false
}

func localProcessBirth(ctx context.Context, pid int) (string, error) {
	if pid <= 1 {
		return "", errors.New("invalid process")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	data, err := cmd.Output()
	value := strings.TrimSpace(string(data))
	if err != nil || value == "" || len(value) > 128 {
		return "", errors.New("process generation unavailable")
	}
	return value, nil
}

func saveLocalAgentBinding(path string, record localAgentBinding) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("unsafe binding directory")
	}
	fd, err := unix.Open(path+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	// Never block the agent on another hook process.
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return err
	}
	defer unix.Flock(fd, unix.LOCK_UN)
	old, err := readLocalAgentBinding(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && old.ProcessID == record.ProcessID && old.Birth == record.Birth {
		// A late exit from the old session must never clear its replacement.
		if record.Cleared && old.SessionID != record.SessionID {
			return nil
		}
		if record.Sequence < old.Sequence {
			return nil
		}
		if record.Sequence == old.Sequence {
			if old.Cleared || (!record.Cleared && old.SessionID == record.SessionID) {
				return nil
			}
			// JSON hook timestamps can collide within one millisecond. Two
			// different IDs with the same timestamp have no reliable ordering:
			// hide both until a newer report instead of keeping the wrong chat.
			record = old
			record.Cleared = true
		}
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".binding-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}
