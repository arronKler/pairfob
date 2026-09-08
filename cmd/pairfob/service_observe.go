package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type serviceObservation struct {
	PID        int
	State      string
	Detail     string
	Executable string
}

func observeService(layout serviceLayout) (serviceObservation, error) {
	if layout.GOOS == "linux" {
		out, err := runServiceCommand([]string{"systemctl", "--user", "show", serviceSystemdUnit(layout), "--no-pager", "--property=MainPID,ActiveState,SubState,Result,ExecMainStatus,ExecStart"})
		if err != nil {
			return serviceObservation{}, fmt.Errorf("read user service: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return parseSystemdObservation(string(out))
	}
	out, err := runServiceCommand([]string{"launchctl", "print", launchdTarget(layout)})
	if err != nil {
		if strings.Contains(string(out), "Could not find service") {
			exe, err := launchdConfiguredExecutable(layout)
			return serviceObservation{State: "stopped", Detail: "not loaded", Executable: exe}, err
		}
		return serviceObservation{}, fmt.Errorf("read user service: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return parseLaunchdObservation(string(out))
}

func parseSystemdObservation(out string) (serviceObservation, error) {
	values := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			values[k] = v
		}
	}
	pid, err := strconv.Atoi(values["MainPID"])
	if err != nil || pid < 0 || values["ActiveState"] == "" {
		return serviceObservation{}, errors.New("invalid user service status")
	}
	state := values["ActiveState"]
	if state == "active" && values["SubState"] == "running" && pid > 0 {
		state = "running"
	}
	if state == "inactive" {
		state = "stopped"
	}
	detail := fmt.Sprintf("%s/%s, result=%s, exit=%s", values["ActiveState"], values["SubState"], values["Result"], values["ExecMainStatus"])
	exe := ""
	if v := values["ExecStart"]; v != "" {
		const prefix = "{ path="
		if !strings.HasPrefix(v, prefix) {
			return serviceObservation{}, errors.New("unrecognized service executable; inspect systemctl --user cat pairfob.service")
		}
		exe, _, _ = strings.Cut(strings.TrimPrefix(v, prefix), " ; argv[]=")
		if !filepath.IsAbs(exe) || strings.Contains(exe, ";") {
			return serviceObservation{}, errors.New("ambiguous service executable")
		}
	}
	return serviceObservation{PID: pid, State: state, Detail: detail, Executable: exe}, nil
}

func parseLaunchdObservation(out string) (serviceObservation, error) {
	read := func(key string) string {
		re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + ` = ([^\n]+)$`)
		m := re.FindStringSubmatch(out)
		if len(m) == 2 {
			return strings.TrimSpace(m[1])
		}
		return ""
	}
	pidText := read("pid")
	pid := 0
	if pidText != "" {
		var err error
		pid, err = strconv.Atoi(pidText)
		if err != nil || pid <= 0 {
			return serviceObservation{}, errors.New("invalid launchd PID")
		}
	}
	state := read("state")
	if state == "" {
		return serviceObservation{}, errors.New("invalid launchd service status")
	}
	if state == "running" && pid == 0 {
		state = "starting"
	}
	return serviceObservation{PID: pid, State: state, Detail: state + ", last exit=" + read("last exit code"), Executable: read("program")}, nil
}

func verifyServiceTarget(status serviceObservation, layout serviceLayout) error {
	if status.Executable == "" {
		return errors.New("cannot verify configured service executable; run pairfob service install")
	}
	actual, err := canonicalInstallTarget(status.Executable)
	if err != nil {
		return err
	}
	expected, err := canonicalInstallTarget(layout.ExecPath)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("service uses %s, but this command updates %s; use the service's executable or reinstall the intended service", actual, expected)
	}
	return nil
}
