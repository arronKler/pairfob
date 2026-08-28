package main

import (
	"strings"
	"testing"
)

func TestLaunchdPlistOmitsGrantAndKeepsAlive(t *testing.T) {
	body := launchdPlist("/opt/pairfob/pairfobd", "/home/u/.config/pairfob/pairfobd.log", "/home/u")
	for _, want := range []string{
		launchdLabel,
		"/opt/pairfob/pairfobd",
		"<key>KeepAlive</key>",
		"<key>RunAtLoad</key>",
		"<key>HOME</key>",
		"<key>PATH</key>",
		"/home/u/.local/bin:",
		"/home/u/.config/pairfob/pairfobd.log",
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
	body := systemdUnitFile("/opt/Pair Fob/pairfobd", "/home/u/.config/pairfob/pairfobd.log", "/home/u")
	if !strings.Contains(body, `ExecStart="/opt/Pair Fob/pairfobd"`) {
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
	cmds := serviceCommands(serviceLayout{GOOS: "darwin", UID: 501, UnitPath: "/Users/x/Library/LaunchAgents/com.pairfob.pairfobd.plist"}, "install")
	joined := fmtCmds(cmds)
	if !strings.Contains(joined, "launchctl bootstrap gui/501") || !strings.Contains(joined, "kickstart -k gui/501/"+launchdLabel) {
		t.Fatalf("cmds=%s", joined)
	}
}

func TestServiceCommandsLinuxEnableNow(t *testing.T) {
	cmds := serviceCommands(serviceLayout{GOOS: "linux"}, "install")
	joined := fmtCmds(cmds)
	if !strings.Contains(joined, "systemctl --user enable --now pairfobd.service") {
		t.Fatalf("cmds=%s", joined)
	}
}

func TestServiceCommandsLinuxRestart(t *testing.T) {
	cmds := serviceCommands(serviceLayout{GOOS: "linux"}, "restart")
	joined := fmtCmds(cmds)
	if !strings.Contains(joined, "systemctl --user restart pairfobd.service") {
		t.Fatalf("cmds=%s", joined)
	}
}

func fmtCmds(cmds [][]string) string {
	parts := make([]string, 0, len(cmds))
	for _, c := range cmds {
		parts = append(parts, strings.Join(c, " "))
	}
	return strings.Join(parts, " ; ")
}
