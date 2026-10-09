package main

import (
	"errors"
	"os"
)

type serviceRecoveryHint struct {
	Note    string
	Command string
}

func localServiceHint() serviceRecoveryHint {
	return recoveryHint(currentServiceLayout())
}

// recoveryHint is used only when the daemon is not answering. It observes the
// service manager without controlling the service or taking its lock.
func recoveryHint(layout serviceLayout, layoutErr error) serviceRecoveryHint {
	if layoutErr != nil || (layout.GOOS != "darwin" && layout.GOOS != "linux") {
		return serviceRecoveryHint{"service unavailable", "pairfob run"}
	}
	if _, err := os.Stat(layout.UnitPath); errors.Is(err, os.ErrNotExist) {
		return serviceRecoveryHint{"service not installed", "pairfob service install"}
	} else if err != nil {
		return serviceRecoveryHint{"service status unavailable", "pairfob service status"}
	}
	observed, err := observeService(layout)
	if err != nil {
		return serviceRecoveryHint{"service status unavailable", "pairfob service status"}
	}
	if observed.State != "running" {
		return serviceRecoveryHint{"service stopped", "pairfob service start"}
	}
	return serviceRecoveryHint{"service running but not answering", "pairfob service restart"}
}

func (h serviceRecoveryHint) advice() string {
	switch h.Command {
	case "pairfob service install":
		return "Install the login service: " + h.Command
	case "pairfob service start":
		return "Start it with: " + h.Command
	case "pairfob service restart":
		return "Restart it with: " + h.Command
	case "pairfob run":
		return "Run it in the foreground: " + h.Command
	default:
		return "Check the service: " + h.Command
	}
}
