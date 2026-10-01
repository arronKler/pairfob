package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"

	"pairfob/internal/daemon"
	"pairfob/internal/runtime"
)

const (
	machineAvailableTTL = 30 * time.Second
	machineListTimeout  = 6 * time.Second
	machineReadyTimeout = 6 * time.Minute
	machineOfferGrace   = 10 * time.Second
)

// machineLinkService runs machine links for paired devices. One job at a time:
// each holds an SSH session and a remote pairing slot.
type machineLinkService struct {
	runtime runtime.Runtime
	remote  machineRemote
	install machineInstall
	dir     string
	logf    func(string, ...any)

	mu        sync.Mutex
	job       daemon.MachineLink
	owner     string
	cancel    context.CancelFunc
	known     map[string]string
	checkedAt time.Time
	available bool
}

func newMachineLinkService(rt runtime.Runtime, dir string, install machineInstall, logf func(string, ...any)) *machineLinkService {
	s := &machineLinkService{
		runtime: rt, dir: dir, install: install, logf: logf,
		job: daemon.MachineLink{Phase: "idle"}, known: map[string]string{},
	}
	if data, err := os.ReadFile(s.knownPath()); err == nil {
		_ = json.Unmarshal(data, &s.known)
	}
	return s
}

// The remote daemon behind each machine this computer has linked, so a device
// can tell which machines it already holds.
func (s *machineLinkService) knownPath() string {
	return filepath.Join(s.dir, "machine-links.json")
}

func (s *machineLinkService) list() ([]runtime.Machine, error) {
	ctx, cancel := context.WithTimeout(context.Background(), machineListTimeout)
	defer cancel()
	return machineLinker{runtime: s.runtime}.machines(ctx)
}

func (s *machineLinkService) Available() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.checkedAt.IsZero() && time.Since(s.checkedAt) < machineAvailableTTL {
		return s.available
	}
	s.mu.Unlock()
	_, sshErr := exec.LookPath(sshBinary(s.remote))
	_, listErr := s.list()
	s.mu.Lock()
	s.available, s.checkedAt = sshErr == nil && listErr == nil, time.Now()
	return s.available
}

func sshBinary(remote machineRemote) string {
	if remote.ssh != "" {
		return remote.ssh
	}
	return "ssh"
}

func (s *machineLinkService) Machines() ([]daemon.Machine, error) {
	machines, err := s.list()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := make([]daemon.Machine, 0, len(machines))
	for _, machine := range machines {
		state := "available"
		switch {
		case !machine.Enabled:
			state = "disabled"
		case !machineSessionSupported(machine):
			state = "session_unsupported"
		}
		rows = append(rows, daemon.Machine{
			ID: machine.ID, Label: boundedLabel(machineLabel(machine)), State: state, DaemonID: s.known[machine.ID],
		})
	}
	return rows, nil
}

func boundedLabel(label string) string {
	const limit = 128
	if utf8.RuneCountInString(label) <= limit {
		return label
	}
	return string([]rune(label)[:limit])
}

func machineLinkActive(phase string) bool {
	return phase == "checking" || phase == "installing" || phase == "offering"
}

func (s *machineLinkService) Start(deviceID, operationID, machineID string, install bool) (daemon.MachineLink, error) {
	machines, err := s.list()
	if err != nil {
		return daemon.MachineLink{}, err
	}
	var machine *runtime.Machine
	for i := range machines {
		if machines[i].ID == machineID {
			machine = &machines[i]
		}
	}
	if machine == nil {
		return daemon.MachineLink{}, errors.New("machine is not saved")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if machineLinkActive(s.job.Phase) {
		return daemon.MachineLink{}, errors.New("a machine link is already running")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.job = daemon.MachineLink{OperationID: operationID, MachineID: machineID, Phase: "checking"}
	s.owner, s.cancel = deviceID, cancel
	go s.run(ctx, cancel, operationID, *machine, install)
	return s.job, nil
}

// update applies a change only while operationID still owns the job.
func (s *machineLinkService) update(operationID string, change func(*daemon.MachineLink)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job.OperationID == operationID {
		change(&s.job)
	}
}

func (s *machineLinkService) run(ctx context.Context, cancel context.CancelFunc, operationID string, machine runtime.Machine, install bool) {
	defer cancel()
	fail := func(code string, err error) {
		if s.logf != nil {
			s.logf("machine link %s: %s: %v", machine.ID, code, err)
		}
		s.update(operationID, func(job *daemon.MachineLink) {
			job.PairURL = ""
			if code == "needs_install" {
				job.Phase = "needs_install"
				return
			}
			job.Phase, job.Error = "failed", code
		})
	}
	linker := machineLinker{
		runtime: s.runtime, remote: s.remote, install: s.install, out: io.Discard,
		confirm: func(string) (bool, error) {
			if install {
				s.update(operationID, func(job *daemon.MachineLink) { job.Phase = "installing" })
			}
			return install, nil
		},
	}
	readyCtx, readyDone := context.WithTimeout(ctx, machineReadyTimeout)
	err := linker.ready(readyCtx, machine)
	readyDone()
	if err != nil {
		fail(machineLinkCode(ctx, err), err)
		return
	}
	offer, err := s.remote.offer(ctx, machine.Target)
	if err != nil {
		fail(machineLinkCode(ctx, machineReachError(machineLabel(machine), machine, err)), err)
		return
	}
	defer offer.Close()
	expiry := time.AfterFunc(time.Until(*offer.Offer.ExpiresAt)+machineOfferGrace, cancel)
	defer expiry.Stop()
	s.update(operationID, func(job *daemon.MachineLink) { job.Phase, job.PairURL = "offering", offer.Offer.URL })
	if err := offer.Wait(); err != nil {
		code := "expired"
		if s.cancelled(operationID) {
			code = "cancelled"
		}
		fail(code, err)
		return
	}
	daemonID := pairURLDaemonID(offer.Offer.URL)
	s.mu.Lock()
	defer s.mu.Unlock()
	if daemonID != "" {
		s.known[machine.ID] = daemonID
		if data, err := json.Marshal(s.known); err == nil {
			_ = os.WriteFile(s.knownPath(), data, 0o600)
		}
	}
	if s.job.OperationID == operationID {
		s.job.Phase, s.job.PairURL = "paired", ""
	}
}

func (s *machineLinkService) cancelled(operationID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.job.OperationID == operationID && s.job.Error == "cancelled"
}

func machineLinkCode(ctx context.Context, err error) string {
	var linkErr *machineLinkError
	if errors.As(err, &linkErr) {
		if ctx.Err() != nil && linkErr.Code != "needs_install" {
			return "cancelled"
		}
		return linkErr.Code
	}
	if ctx.Err() != nil {
		return "cancelled"
	}
	return "internal"
}

func pairURLDaemonID(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	fragment, err := url.ParseQuery(u.Fragment)
	if err != nil {
		return ""
	}
	if id := fragment.Get("d"); daemonIDPattern.MatchString(id) {
		return id
	}
	return ""
}

func (s *machineLinkService) Status(deviceID string) daemon.MachineLink {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.job
	if deviceID != s.owner {
		job.PairURL = ""
	}
	return job
}

func (s *machineLinkService) Cancel(deviceID, operationID string) daemon.MachineLink {
	s.mu.Lock()
	if s.job.OperationID == operationID && s.owner == deviceID && machineLinkActive(s.job.Phase) {
		// Mark first so the job reports why its SSH session went away.
		s.job.Phase, s.job.Error, s.job.PairURL = "failed", "cancelled", ""
		s.cancel()
	}
	s.mu.Unlock()
	return s.Status(deviceID)
}
