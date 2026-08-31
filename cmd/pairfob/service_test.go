package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchdPlistOmitsGrantAndKeepsAlive(t *testing.T) {
	body := launchdPlist("/opt/pairfob/pairfob", "/home/u/.config/pairfob/pairfob.log", "/home/u")
	for _, want := range []string{
		launchdLabel,
		"/opt/pairfob/pairfob",
		"<key>KeepAlive</key>",
		"<key>RunAtLoad</key>",
		"<key>HOME</key>",
		"<key>PATH</key>",
		"/home/u/.local/bin:",
		"/home/u/.config/pairfob/pairfob.log",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in %s", want, body)
		}
	}
	for _, forbidden := range []string{"JOIN_GRANT", "jg_", "PAIRFOB_JOIN"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("service unit leaked %q", forbidden)
		}
	}
}

func TestSystemdUnitQuotesSpacesAndOmitsGrant(t *testing.T) {
	body := systemdUnitFile("/opt/Pair Fob/pairfob", "/home/u/.config/pairfob/pairfob.log", "/home/u")
	if !strings.Contains(body, `ExecStart="/opt/Pair Fob/pairfob"`) {
		t.Fatalf("ExecStart not quoted: %s", body)
	}
	if strings.Contains(body, "JOIN_GRANT") {
		t.Fatal(body)
	}
	if !strings.Contains(body, "Environment=PATH=") || !strings.Contains(body, "/home/u/.local/bin:") {
		t.Fatalf("PATH missing: %s", body)
	}
}

func TestLaunchdPlistEscapesXML(t *testing.T) {
	body := launchdPlist(`/tmp/a&b<c>`, `/tmp/out`, `/tmp`)
	if strings.Contains(body, `/tmp/a&b<c>`) || !strings.Contains(body, `/tmp/a&amp;b&lt;c&gt;`) {
		t.Fatalf("path not escaped: %s", body)
	}
}

func TestServiceCommandsDarwinInstallBootstrapsUserAgent(t *testing.T) {
	cmds := serviceCommands(serviceLayout{GOOS: "darwin", UID: 501, UnitPath: "/Users/x/Library/LaunchAgents/com.pairfob.pairfob.plist"}, "install")
	joined := fmtCmds(cmds)
	if !strings.Contains(joined, "launchctl bootstrap gui/501") || !strings.Contains(joined, "kickstart -k gui/501/"+launchdLabel) {
		t.Fatalf("cmds=%s", joined)
	}
}

func TestServiceCommandsLinuxEnableNow(t *testing.T) {
	cmds := serviceCommands(serviceLayout{GOOS: "linux"}, "install")
	joined := fmtCmds(cmds)
	if !strings.Contains(joined, "systemctl --user enable --now pairfob.service") {
		t.Fatalf("cmds=%s", joined)
	}
}

func TestServiceCommandsLinuxRestart(t *testing.T) {
	cmds := serviceCommands(serviceLayout{GOOS: "linux"}, "restart")
	joined := fmtCmds(cmds)
	if !strings.Contains(joined, "systemctl --user restart pairfob.service") {
		t.Fatalf("cmds=%s", joined)
	}
}

func TestServiceCommandsUseLayoutSpecificLegacyIdentifiers(t *testing.T) {
	darwin := serviceCommands(serviceLayout{
		GOOS:         "darwin",
		UID:          501,
		UnitPath:     "/Users/x/Library/LaunchAgents/com.pairfob.pairfobd.plist",
		LaunchdLabel: legacyLaunchdLabel,
	}, "uninstall")
	if got := fmtCmds(darwin); !strings.Contains(got, "gui/501/"+legacyLaunchdLabel) {
		t.Fatalf("darwin commands=%s", got)
	}

	linux := serviceCommands(serviceLayout{GOOS: "linux", SystemdUnit: legacySystemdUnit}, "uninstall")
	if got := fmtCmds(linux); !strings.Contains(got, "disable --now "+legacySystemdUnit) {
		t.Fatalf("linux commands=%s", got)
	}
}

func TestUninstallKeepsUnitWhenServiceIsStillActive(t *testing.T) {
	unitPath := writeServiceUnit(t)
	calls := 0
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		calls++
		switch calls {
		case 1:
			return []byte("service = active"), nil
		case 2:
			return []byte("bootout failed"), errors.New("exit 5")
		case 3:
			return []byte("service = active"), nil
		default:
			t.Fatalf("unexpected command: %v", args)
			return nil, nil
		}
	})

	layout := serviceLayout{GOOS: "darwin", UID: 501, UnitPath: unitPath}
	if err := uninstallServiceLayout(layout); err == nil || !strings.Contains(err.Error(), "still active") {
		t.Fatalf("uninstall error=%v", err)
	}
	if _, err := os.Stat(unitPath); err != nil {
		t.Fatalf("unit was removed after failed stop: %v", err)
	}
}

func TestUninstallAcceptsStopErrorAfterVerifiedExit(t *testing.T) {
	unitPath := writeServiceUnit(t)
	calls := 0
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		calls++
		switch calls {
		case 1:
			return []byte("service = active"), nil
		case 2:
			return []byte("bootout raced"), errors.New("exit 3")
		case 3:
			return []byte(`Could not find service "com.pairfob.pairfob"`), errors.New("exit 113")
		default:
			t.Fatalf("unexpected command: %v", args)
			return nil, nil
		}
	})

	layout := serviceLayout{GOOS: "darwin", UID: 501, UnitPath: unitPath}
	if err := uninstallServiceLayout(layout); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if _, err := os.Stat(unitPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unit still exists: %v", err)
	}
}

func TestLinuxUninstallKeepsUnitWhenDisableFails(t *testing.T) {
	unitPath := writeServiceUnit(t)
	calls := 0
	stubServiceRunner(t, func(args []string) ([]byte, error) {
		calls++
		switch calls {
		case 1:
			return []byte("inactive"), errors.New("exit 3")
		case 2:
			return []byte("disable failed"), errors.New("exit 1")
		case 3:
			return []byte("inactive"), errors.New("exit 3")
		default:
			t.Fatalf("unexpected command: %v", args)
			return nil, nil
		}
	})

	layout := serviceLayout{GOOS: "linux", UnitPath: unitPath}
	if err := uninstallServiceLayout(layout); err == nil || !strings.Contains(err.Error(), "disable service") {
		t.Fatalf("uninstall error=%v", err)
	}
	if _, err := os.Stat(unitPath); err != nil {
		t.Fatalf("unit was removed after failed disable: %v", err)
	}
}

func TestUninstallMissingUnitIsIdempotentWithoutServiceManager(t *testing.T) {
	stubServiceRunner(t, func([]string) ([]byte, error) {
		return []byte("Failed to connect to bus"), errors.New("exit 1")
	})
	layout := serviceLayout{GOOS: "linux", UnitPath: filepath.Join(t.TempDir(), "missing.service")}
	if err := uninstallServiceLayout(layout); err != nil {
		t.Fatalf("uninstall missing unit: %v", err)
	}
}

func writeServiceUnit(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pairfob.plist")
	if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func stubServiceRunner(t *testing.T, runner func([]string) ([]byte, error)) {
	t.Helper()
	previous := runServiceCommand
	runServiceCommand = runner
	t.Cleanup(func() { runServiceCommand = previous })
}

func fmtCmds(cmds [][]string) string {
	parts := make([]string, 0, len(cmds))
	for _, c := range cmds {
		parts = append(parts, strings.Join(c, " "))
	}
	return strings.Join(parts, " ; ")
}
