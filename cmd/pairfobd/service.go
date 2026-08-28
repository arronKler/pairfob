package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"pairfob/internal/state"
)

const (
	launchdLabel  = "com.pairfob.pairfobd"
	systemdUnit   = "pairfobd.service"
	serviceLogRel = "pairfobd.log"
)

func serviceCommand(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: pairfobd service install|uninstall|start|restart|stop|status")
	}
	switch args[0] {
	case "install":
		return installUserService()
	case "uninstall":
		return uninstallUserService()
	case "start":
		return controlUserService("start")
	case "restart":
		return controlUserService("restart")
	case "stop":
		return controlUserService("stop")
	case "status":
		return statusUserService()
	default:
		return errors.New("usage: pairfobd service install|uninstall|start|restart|stop|status")
	}
}

type serviceLayout struct {
	GOOS     string
	ExecPath string
	Home     string
	UID      int
	StateDir string
	LogPath  string
	UnitPath string
}

func currentServiceLayout() (serviceLayout, error) {
	execPath, err := resolvedExecutable()
	if err != nil {
		return serviceLayout{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return serviceLayout{}, err
	}
	stateDir, err := state.DefaultDir()
	if err != nil {
		return serviceLayout{}, err
	}
	uid := os.Getuid()
	layout := serviceLayout{
		GOOS:     runtime.GOOS,
		ExecPath: execPath,
		Home:     home,
		UID:      uid,
		StateDir: stateDir,
		LogPath:  filepath.Join(stateDir, serviceLogRel),
	}
	switch runtime.GOOS {
	case "darwin":
		layout.UnitPath = filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist")
	case "linux":
		layout.UnitPath = filepath.Join(home, ".config", "systemd", "user", systemdUnit)
	default:
		return serviceLayout{}, errors.New("user service is supported on macOS and Linux")
	}
	return layout, nil
}

func resolvedExecutable() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

func launchdPlist(execPath, logPath, home string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + xmlEscape(launchdLabel) + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + xmlEscape(execPath) + `</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>` + xmlEscape(home) + `</string>
  <key>StandardOutPath</key>
  <string>` + xmlEscape(logPath) + `</string>
  <key>StandardErrorPath</key>
  <string>` + xmlEscape(logPath) + `</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>` + xmlEscape(home) + `</string>
    <key>PATH</key>
    <string>` + xmlEscape(userServicePATH(home)) + `</string>
  </dict>
</dict>
</plist>
`
}

func systemdUnitFile(execPath, logPath, home string) string {
	return `[Unit]
Description=pairfobd (Pairfob daemon)
After=network-online.target

[Service]
Type=simple
ExecStart=` + systemdQuote(execPath) + `
WorkingDirectory=` + systemdQuote(home) + `
Restart=on-failure
RestartSec=5
StandardOutput=append:` + systemdQuote(logPath) + `
StandardError=append:` + systemdQuote(logPath) + `
Environment=HOME=` + systemdQuote(home) + `
Environment=PATH=` + systemdQuote(userServicePATH(home)) + `

[Install]
WantedBy=default.target
`
}

func userServicePATH(home string) string {
	return strings.Join([]string{
		filepath.Join(home, ".local", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	}, ":")
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

func systemdQuote(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\"'\\") {
		return strconv.Quote(s)
	}
	return s
}

func launchdTarget(uid int) string {
	return "gui/" + strconv.Itoa(uid) + "/" + launchdLabel
}

func installUserService() error {
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(layout.StateDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(layout.UnitPath), 0o755); err != nil {
		return err
	}
	body := []byte(unitBody(layout))
	if err := os.WriteFile(layout.UnitPath, body, 0o644); err != nil {
		return err
	}
	if err := applyService(layout, "install"); err != nil {
		return err
	}
	fmt.Printf("installed user service %s\nlogs: %s\n", layout.UnitPath, layout.LogPath)
	return nil
}

func uninstallUserService() error {
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	_ = applyService(layout, "uninstall")
	if err := os.Remove(layout.UnitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Printf("removed user service %s\nstate kept in %s\n", layout.UnitPath, layout.StateDir)
	return nil
}

func controlUserService(action string) error {
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	if _, err := os.Stat(layout.UnitPath); err != nil {
		return fmt.Errorf("user service is not installed; run pairfobd service install")
	}
	if err := applyService(layout, action); err != nil {
		return err
	}
	fmt.Printf("%s %s\n", action, layout.UnitPath)
	return nil
}

func statusUserService() error {
	layout, err := currentServiceLayout()
	if err != nil {
		return err
	}
	if _, err := os.Stat(layout.UnitPath); err != nil {
		fmt.Println("not installed")
		return nil
	}
	if err := applyService(layout, "status"); err != nil {
		fmt.Println("stopped")
		return nil
	}
	fmt.Println("running")
	return nil
}

func unitBody(layout serviceLayout) string {
	switch layout.GOOS {
	case "darwin":
		return launchdPlist(layout.ExecPath, layout.LogPath, layout.Home)
	case "linux":
		return systemdUnitFile(layout.ExecPath, layout.LogPath, layout.Home)
	default:
		return ""
	}
}

func applyService(layout serviceLayout, action string) error {
	cmds := serviceCommands(layout, action)
	var firstErr error
	for _, c := range cmds {
		if len(c) == 0 {
			continue
		}
		err := exec.Command(c[0], c[1:]...).Run()
		if c[0] == "launchctl" && len(c) > 1 && c[1] == "bootout" {
			continue
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func serviceCommands(layout serviceLayout, action string) [][]string {
	switch layout.GOOS {
	case "darwin":
		domain := "gui/" + strconv.Itoa(layout.UID)
		target := launchdTarget(layout.UID)
		switch action {
		case "install":
			return [][]string{
				{"launchctl", "bootout", target},
				{"launchctl", "bootstrap", domain, layout.UnitPath},
				{"launchctl", "enable", target},
				{"launchctl", "kickstart", "-k", target},
			}
		case "start", "restart":
			return [][]string{{"launchctl", "kickstart", "-k", target}}
		case "stop":
			return [][]string{{"launchctl", "bootout", target}}
		case "status":
			return [][]string{{"launchctl", "print", target}}
		case "uninstall":
			return [][]string{{"launchctl", "bootout", target}}
		}
	case "linux":
		switch action {
		case "install":
			return [][]string{
				{"systemctl", "--user", "daemon-reload"},
				{"systemctl", "--user", "enable", "--now", systemdUnit},
			}
		case "start":
			return [][]string{{"systemctl", "--user", "start", systemdUnit}}
		case "restart":
			return [][]string{{"systemctl", "--user", "restart", systemdUnit}}
		case "stop":
			return [][]string{{"systemctl", "--user", "stop", systemdUnit}}
		case "status":
			return [][]string{{"systemctl", "--user", "is-active", systemdUnit}}
		case "uninstall":
			return [][]string{
				{"systemctl", "--user", "disable", "--now", systemdUnit},
				{"systemctl", "--user", "daemon-reload"},
			}
		}
	}
	return nil
}
