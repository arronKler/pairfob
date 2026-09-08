package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"pairfob/internal/admin"
)

func writeServiceStatus(w io.Writer, layout serviceLayout) error {
	status := serviceObservation{State: "stopped", Detail: "not installed"}
	if _, err := os.Stat(layout.UnitPath); err == nil {
		status, err = observeService(layout)
		if err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Fprintf(w, "Service     %s (%s)\n", status.State, status.Detail)
	sock, err := admin.SocketPathIn(layout.StateDir)
	if err != nil {
		return err
	}
	p, err := inspectLocalProcess(sock)
	if errors.Is(err, admin.ErrNotRunning) {
		fmt.Fprintln(w, "Daemon      not running")
		if status.State == "stopped" {
			return nil
		}
		return errors.New("service has no responding daemon; inspect " + layout.LogPath)
	}
	if err != nil {
		return fmt.Errorf("daemon could not be verified: %w", err)
	}
	defer p.peer.Close()
	if p.legacy {
		fmt.Fprintf(w, "Daemon      PID %d, running version unknown (legacy interface)\n", p.peer.PID)
	} else {
		fmt.Fprintf(w, "Daemon      %s, PID %d\nExecutable  %s\n", p.info.Version, p.info.PID, p.info.Executable)
	}
	if status.State != "running" || status.PID != p.peer.PID {
		return fmt.Errorf("PID %d is running outside this service; run pairfob service restart to reconcile it", p.peer.PID)
	}
	if p.legacy {
		return errors.New("running version cannot be verified; run pairfob update")
	}
	want, err := executableHash(layout.ExecPath)
	if err != nil {
		return err
	}
	if err := processBelongsTo(p.info, layout); err != nil {
		return err
	}
	if err := verifyServiceTarget(status, layout); err != nil {
		return err
	}
	if p.info.SHA256 != want || p.info.Version != version {
		return errors.New("installed and running programs differ; run pairfob service restart")
	}
	return nil
}
