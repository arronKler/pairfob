package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"pairfob/internal/daemon"
)

// The process execs the verified binary in place, retaining its service-manager
// PID. A startup watchdog restores the backup if the new process cannot connect.
type remoteUpdater struct {
	candidateHash, backupHash string
	mu                        sync.Mutex
	dir, dest, base           string
	available                 bool
	job                       daemon.UpdateStatus
	run                       func(string) error
}

var releaseVersion = regexp.MustCompile(`^v?[0-9]+(?:[.-][0-9]+){1,3}$`)

func newRemoteUpdater(dir string) *remoteUpdater {
	dest, _ := resolvedExecutable()
	u := &remoteUpdater{dir: dir, dest: dest, base: defaultDownloadBase, available: managedDaemon(), job: daemon.UpdateStatus{Phase: "idle"}}
	if data, err := os.ReadFile(u.jobPath()); err == nil {
		_ = u.load(data)
	}
	if u.job.Phase == "downloading" {
		u.job.Phase = "failed"
		_ = u.save()
	}
	u.run = u.install
	return u
}
func managedDaemon() bool {
	layout, err := currentServiceLayout()
	if err != nil {
		return false
	}
	if _, err = os.Stat(layout.UnitPath); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if runtime.GOOS == "darwin" {
		out, err := exec.CommandContext(ctx, "launchctl", "print", fmt.Sprintf("gui/%d/%s", layout.UID, layout.LaunchdLabel)).Output()
		if err != nil {
			return false
		}
		re := regexp.MustCompile(`(?m)^\s*pid = ([0-9]+)\s*$`)
		m := re.FindStringSubmatch(string(out))
		return len(m) == 2 && m[1] == strconv.Itoa(os.Getpid())
	}
	out, err := exec.CommandContext(ctx, "systemctl", "--user", "show", layout.SystemdUnit, "--property=MainPID", "--value").Output()
	return err == nil && strings.TrimSpace(string(out)) == strconv.Itoa(os.Getpid())
}
func (u *remoteUpdater) jobPath() string    { return filepath.Join(u.dir, "daemon-update.json") }
func (u *remoteUpdater) backupPath() string { return filepath.Join(u.dir, "daemon-update-backup") }
func (u *remoteUpdater) save() error {
	data, err := json.Marshal(updateJournal{UpdateStatus: u.job, CandidateHash: u.candidateHash, BackupHash: u.backupHash})
	if err != nil {
		return err
	}
	return writeUpdateJournal(u.jobPath(), data)
}
func (u *remoteUpdater) Status() daemon.UpdateStatus {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.job.Phase == "verifying" && u.job.Target == version {
		if data, err := os.ReadFile(u.jobPath()); err == nil {
			var saved daemon.UpdateStatus
			if json.Unmarshal(data, &saved) == nil {
				u.job = saved
			}
		}
	}
	s := u.job
	s.Available = u.available
	return s
}
func (u *remoteUpdater) Start(id, target string) (daemon.UpdateStatus, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if id == u.job.OperationID && target == u.job.Target {
		s := u.job
		s.Available = u.available
		return s, nil
	}
	if id == u.job.OperationID {
		return daemon.UpdateStatus{}, errors.New("operation target mismatch")
	}
	if !u.available || !releaseVersion.MatchString(target) || !newerVersion(target, version) || u.job.Phase == "downloading" || u.job.Phase == "restarting" || u.job.Phase == "verifying" {
		return daemon.UpdateStatus{}, errors.New("update unavailable")
	}
	old := u.job
	u.job = daemon.UpdateStatus{Phase: "downloading", Target: target, OperationID: id}
	if err := u.save(); err != nil {
		u.job = old
		return daemon.UpdateStatus{}, err
	}
	go func() {
		if err := u.run(target); err != nil {
			u.mu.Lock()
			u.job.Phase = "failed"
			_ = u.save()
			u.mu.Unlock()
		}
	}()
	s := u.job
	s.Available = true
	return s, nil
}
func newerVersion(a, b string) bool {
	if !releaseVersion.MatchString(a) || !releaseVersion.MatchString(b) {
		return false
	}
	split := func(s string) []string {
		return strings.FieldsFunc(strings.TrimPrefix(s, "v"), func(r rune) bool { return r == '.' || r == '-' })
	}
	aa, bb := split(a), split(b)
	if len(aa) != len(bb) {
		return false
	}
	for i := range aa {
		x, e := strconv.ParseUint(aa[i], 10, 53)
		y, f := strconv.ParseUint(bb[i], 10, 53)
		if e != nil || f != nil {
			return false
		}
		if x != y {
			return x > y
		}
	}
	return false
}
func (u *remoteUpdater) install(target string) error {
	return u.installAndActivate(target, syscall.Exec)
}
func (u *remoteUpdater) installAndActivate(target string, activate func(string, []string, []string) error) error {
	unlock, err := lockUpdate(u.dest)
	if err != nil {
		return err
	}
	defer unlock()
	latest, err := fetchDownloadText(u.base+"/VERSION", 4096)
	if err != nil {
		return err
	}
	if strings.TrimSpace(latest) != target {
		return errors.New("release changed; check again")
	}
	sums, err := fetchDownloadText(u.base+"/SHA256SUMS", 1<<16)
	if err != nil {
		return err
	}
	name := artifactName(runtime.GOOS, runtime.GOARCH)
	want, err := checksumFor(sums, name)
	if err != nil {
		return err
	}
	payload, err := fetchDownloadArtifact(u.base + "/" + name)
	if err != nil {
		return err
	}
	if sha256Hex(payload) != want {
		return errors.New("checksum mismatch")
	}
	// Execute only a checksum-verified candidate, with a bounded version probe.
	candidate, err := os.CreateTemp(filepath.Dir(u.dest), ".pairfob-candidate-*")
	if err != nil {
		return err
	}
	path := candidate.Name()
	candidate.Close()
	defer os.Remove(path)
	if err = replaceExecutable(path, payload); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return err
	}
	if !strings.HasPrefix(string(out), "pairfob "+target+" ") {
		return errors.New("candidate version mismatch")
	}
	if err = os.Remove(path); err != nil {
		return err
	}
	previous, err := os.ReadFile(u.dest)
	if err != nil {
		return err
	}
	u.candidateHash = want
	u.backupHash = sha256Hex(previous)
	if err = replaceExecutable(u.backupPath(), previous); err != nil {
		return err
	}
	u.mu.Lock()
	u.job.Phase = "restarting"
	err = u.save()
	u.mu.Unlock()
	if err != nil {
		return err
	}
	if err = writeUpdateJournal(u.dest+".update-pending", []byte(u.jobPath())); err != nil {
		return err
	}
	activated := false
	defer func() {
		if !activated {
			_ = os.Remove(u.dest + ".update-pending")
		}
	}()
	if err = replaceExecutable(u.dest, payload); err != nil {
		return err
	}
	// Give the accepted reply a chance to reach the phone; success is established
	// only by a later authenticated config reporting the new running version.
	time.Sleep(time.Second)
	if err = activate(u.dest, []string{u.dest}, os.Environ()); err != nil {
		if restoreErr := replaceExecutable(u.dest, previous); restoreErr != nil {
			return fmt.Errorf("exec failed and restore failed: %w", restoreErr)
		}
		return err
	}
	activated = true
	return nil
}
func lockUpdate(dest string) (func(), error) {
	f, err := os.OpenFile(dest+".update-lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another updater is running")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
