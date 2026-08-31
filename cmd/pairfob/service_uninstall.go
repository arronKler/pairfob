package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

var runServiceCommand = func(args []string) ([]byte, error) {
	if len(args) == 0 {
		return nil, errors.New("empty service command")
	}
	return exec.Command(args[0], args[1:]...).CombinedOutput()
}

func serviceLaunchdLabel(layout serviceLayout) string {
	if layout.LaunchdLabel != "" {
		return layout.LaunchdLabel
	}
	return launchdLabel
}

func serviceSystemdUnit(layout serviceLayout) string {
	if layout.SystemdUnit != "" {
		return layout.SystemdUnit
	}
	return systemdUnit
}

func serviceActive(layout serviceLayout) (bool, error) {
	cmds := serviceCommands(layout, "status")
	if len(cmds) != 1 {
		return false, fmt.Errorf("unsupported service platform %q", layout.GOOS)
	}
	out, err := runServiceCommand(cmds[0])
	status := strings.TrimSpace(string(out))
	switch layout.GOOS {
	case "darwin":
		if err == nil {
			return true, nil
		}
		if strings.Contains(status, "Could not find service") {
			return false, nil
		}
	case "linux":
		switch status {
		case "active", "activating", "reloading", "deactivating":
			return true, nil
		case "inactive", "failed", "unknown":
			return false, nil
		}
	}
	if err != nil {
		return false, fmt.Errorf("check service status: %w: %s", err, status)
	}
	return false, fmt.Errorf("unexpected service status %q", status)
}

func uninstallServiceLayout(layout serviceLayout) error {
	_, statErr := os.Stat(layout.UnitPath)
	unitExists := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}

	active, statusErr := serviceActive(layout)
	if statusErr != nil {
		if !unitExists {
			return nil
		}
		return statusErr
	}

	shouldStop := active || (unitExists && layout.GOOS == "linux")
	if shouldStop {
		stopErr := applyService(layout, "uninstall")
		stillActive, verifyErr := serviceActive(layout)
		if verifyErr != nil {
			return fmt.Errorf("verify service stopped: %w", verifyErr)
		}
		if stillActive {
			if stopErr != nil {
				return fmt.Errorf("stop service: %w (service is still active)", stopErr)
			}
			return errors.New("service is still active after stop")
		}
		if stopErr != nil && layout.GOOS == "linux" {
			return fmt.Errorf("disable service: %w", stopErr)
		}
	}

	if err := os.Remove(layout.UnitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if unitExists && layout.GOOS == "linux" {
		if out, err := runServiceCommand([]string{"systemctl", "--user", "daemon-reload"}); err != nil {
			return fmt.Errorf("reload user services: %w: %s", err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}
