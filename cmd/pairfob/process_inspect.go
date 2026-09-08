package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"pairfob/internal/admin"
)

type localProcess struct {
	peer   *admin.Peer
	info   admin.ProcessInfo
	legacy bool
}

func inspectLocalProcess(sock string) (*localProcess, error) {
	peer, err := admin.OpenPeer(sock)
	if err != nil {
		return nil, err
	}
	p := &localProcess{peer: peer}
	response, err := peer.Request(admin.Request{Op: "daemon.info"})
	if err != nil {
		peer.Close()
		return nil, err
	}
	if !response.OK {
		if response.Error == "unknown_op" {
			p.legacy = true
			return p, nil
		}
		peer.Close()
		return nil, fmt.Errorf("inspect running daemon: %s", response.Error)
	}
	if json.Unmarshal(response.Result, &p.info) != nil || !validProcessInfo(p.info, peer.PID) {
		peer.Close()
		return nil, errors.New("invalid running daemon identity")
	}
	return p, nil
}

func validProcessInfo(info admin.ProcessInfo, pid int) bool {
	hash, hashErr := hex.DecodeString(info.SHA256)
	instance, instanceErr := hex.DecodeString(info.Instance)
	return info.PID == pid && pid > 0 && info.Version != "" && len(info.Version) <= 256 &&
		filepath.IsAbs(info.Executable) && filepath.IsAbs(info.StateDir) &&
		hashErr == nil && len(hash) == 32 && instanceErr == nil && len(instance) == 16
}

func processBelongsTo(info admin.ProcessInfo, layout serviceLayout) error {
	if info.PID <= 1 || info.PID == os.Getpid() {
		return errors.New("refusing to stop this process")
	}
	exe, err := canonicalInstallTarget(layout.ExecPath)
	if err != nil {
		return err
	}
	dir, err := filepath.Abs(layout.StateDir)
	if err != nil {
		return err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	if filepath.Clean(info.Executable) != exe || filepath.Clean(info.StateDir) != dir {
		return fmt.Errorf("another Pairfob instance owns the socket (PID %d, executable %s, state %s); stop that instance explicitly", info.PID, info.Executable, info.StateDir)
	}
	return nil
}

func stopLocalProcess(sock string, observed *localProcess, layout serviceLayout) error {
	if observed.legacy {
		return stopLegacyProcess(sock, observed.peer, layout)
	}
	if err := processBelongsTo(observed.info, layout); err != nil {
		return err
	}
	peer, err := admin.OpenPeer(sock)
	if errors.Is(err, admin.ErrNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	defer peer.Close()
	if peer.PID != observed.info.PID {
		return errors.New("socket owner changed; retry after inspecting the running instance")
	}
	response, err := peer.Request(admin.Request{Op: "daemon.stop", Instance: observed.info.Instance})
	if err != nil {
		return fmt.Errorf("daemon stop outcome is unknown: %w; inspect before retrying", err)
	}
	if !response.OK {
		return fmt.Errorf("stop daemon: %s", response.Error)
	}
	return nil
}
