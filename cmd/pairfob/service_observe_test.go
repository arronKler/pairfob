package main

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestServiceObservationShowsRestartLoop(t *testing.T) {
	s, err := parseSystemdObservation("MainPID=0\nActiveState=activating\nSubState=auto-restart\nResult=exit-code\nExecMainStatus=1\n")
	if err != nil || s.State != "activating" || !strings.Contains(s.Detail, "auto-restart") {
		t.Fatalf("%+v %v", s, err)
	}
	s, err = parseLaunchdObservation("service = {\n state = spawn scheduled\n last exit code = 1\n}")
	if err != nil || s.State == "running" || s.PID != 0 {
		t.Fatalf("%+v %v", s, err)
	}
}

func TestPrepareInstallRefusesDifferentServiceExecutable(t *testing.T) {
	for _, unloaded := range []bool{false, true} {
		t.Run(map[bool]string{false: "loaded", true: "unloaded launchd"}[unloaded], func(t *testing.T) {
			layout, _ := lifecycleFixture(t)
			other := layout
			other.ExecPath = os.TempDir()
			if unloaded {
				layout.GOOS = "darwin"
				if err := os.WriteFile(layout.UnitPath, []byte(launchdPlist(other.ExecPath, layout.LogPath, layout.Home)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			stubServiceRunner(t, func(args []string) ([]byte, error) {
				if args[1] == "print" {
					if unloaded {
						return []byte("Could not find service"), errors.New("unloaded")
					}
					return fakeManagerOutput(other, 123), nil
				}
				if len(args) > 2 && args[2] == "show" {
					return fakeManagerOutput(other, 0), nil
				}
				t.Fatalf("preflight performed a mutation: %v", args)
				return nil, nil
			})
			if err := prepareServiceInstall(layout); err == nil || !strings.Contains(err.Error(), "service uses") {
				t.Fatalf("%v", err)
			}
		})
	}
}

func TestServiceStatusReportsIndependentDaemonWithoutUnit(t *testing.T) {
	layout, sock := lifecycleFixture(t)
	startLifecycleChild(t, layout.StateDir, sock, "v1.1.0", false)
	if err := os.Remove(layout.UnitPath); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err := writeServiceStatus(&out, layout)
	if err == nil || !strings.Contains(err.Error(), "outside this service") || !strings.Contains(out.String(), "v1.1.0") || !strings.Contains(out.String(), "not installed") {
		t.Fatalf("%s %v", out.String(), err)
	}
}

func TestLaunchdPlistProgramPrecedenceAndMalformed(t *testing.T) {
	layout, _ := lifecycleFixture(t)
	for _, test := range []string{"program", "duplicate", "malformed"} {
		body := launchdPlist(layout.ExecPath, layout.LogPath, layout.Home)
		if test == "program" {
			body = strings.Replace(body, "<key>ProgramArguments</key>", "<key>Program</key><string>/other/bin</string><key>ProgramArguments</key>", 1)
		}
		if test == "duplicate" {
			body = strings.Replace(body, "<key>ProgramArguments</key>", "<key>Program</key><string>/one</string><key>Program</key><string>/two</string><key>ProgramArguments</key>", 1)
		}
		if test == "malformed" {
			body = "not a plist"
		}
		if err := os.WriteFile(layout.UnitPath, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		exe, err := launchdConfiguredExecutable(layout)
		if test == "program" {
			if err != nil || exe != "/other/bin" {
				t.Fatalf("%s %v", exe, err)
			}
		} else if err == nil {
			t.Fatal("accepted " + test)
		}
	}
}
