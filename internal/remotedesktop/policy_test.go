package remotedesktop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnattendedGrantRequiresExplicitMigrationAndSurvivesRestart(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	path := filepath.Join(h.Dir, "desktop-access")
	if err := os.WriteFile(path, []byte("control\n"), 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := h.read()
	if readDecision(before).ID != "" {
		t.Fatal("legacy per-open consent enabled unattended access")
	}
	dialogs := 0
	query := func(mode, display string) (setupResult, error) {
		dialogs++
		if mode != "setup" {
			t.Fatalf("unexpected action %q", mode)
		}
		return setupResult{Mode: "control", Display: "display-uuid", Screen: true, Accessibility: false}, nil
	}
	message, err := h.configure("offer", true, query)
	if err != nil || !strings.Contains(message, "Finish granting Accessibility") {
		t.Fatalf("%q, %v", message, err)
	}
	restarted := LocalHost{Dir: h.Dir}
	raw, err := restarted.read()
	if err != nil {
		t.Fatal(err)
	}
	grant := readDecision(raw)
	if grant.Mode != "control" || grant.Display != "display-uuid" || grant.ID == "" {
		t.Fatalf("grant: %+v", grant)
	}
	if _, err = restarted.configure("offer", true, query); err != nil || dialogs != 1 {
		t.Fatalf("reinstall prompted: %d, %v", dialogs, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("grant permissions")
	}
}

func TestUnattendedDisableWinsOverPendingSetup(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	_, err := h.configure("enable-control", true, func(string, string) (setupResult, error) {
		if err := h.Disable(); err != nil {
			t.Fatal(err)
		}
		return setupResult{Mode: "control", Display: "primary"}, nil
	})
	if err == nil {
		t.Fatal("late setup overwrote disable")
	}
	raw, _ := h.read()
	if readDecision(raw).Mode != "off" {
		t.Fatal("disabled grant lost")
	}
}

func TestInstallerDeclineCanBeChangedLater(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	if _, err := h.configure("offer", true, func(string, string) (setupResult, error) { return setupResult{Mode: "skip"}, nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := h.configure("offer", true, func(string, string) (setupResult, error) {
		t.Fatal("installer prompted again")
		return setupResult{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.configure("setup", true, func(string, string) (setupResult, error) {
		return setupResult{Mode: "view", Display: "primary", Screen: true}, nil
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := h.read()
	g := readDecision(raw)
	if g.Mode != "view" {
		t.Fatal(g)
	}
	if _, err := h.configure("enable-control", true, func(string, string) (setupResult, error) { return setupResult{Mode: "skip"}, nil }); err != nil {
		t.Fatal(err)
	}
	raw, _ = h.read()
	if readDecision(raw) != g {
		t.Fatal("cancel changed existing decision")
	}
}

func TestDesktopStatusOnlyInspectsSystemPermissions(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	if err := h.save(nil, true, "control", "primary"); err != nil {
		t.Fatal(err)
	}
	message, err := h.configure("status", true, func(mode, display string) (setupResult, error) {
		if mode != "status" {
			t.Fatal(mode)
		}
		return setupResult{Screen: true, Accessibility: true, Unlocked: true, DisplayAwake: true}, nil
	})
	if err != nil || !strings.Contains(message, "Local desktop checks passed") {
		t.Fatal(message, err)
	}
}

func TestDesktopReadinessListsUnavailableConditions(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	if err := h.save(nil, true, "view", "specific-screen"); err != nil {
		t.Fatal(err)
	}
	got, err := h.configure("status", false, func(action, display string) (setupResult, error) {
		if action != "status" || display != "specific-screen" {
			t.Fatal(action, display)
		}
		return setupResult{Screen: true}, nil
	})
	if err != nil || strings.Contains(got, "checks passed") {
		t.Fatal(got, err)
	}
	for _, reason := range []string{"P2P is disabled", "unlocked", "display is unavailable"} {
		if !strings.Contains(got, reason) {
			t.Fatal(got)
		}
	}
}

func TestDesktopStandbyPersistsWithoutRotatingGrant(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	never := func(string, string) (setupResult, error) {
		t.Fatal("standby requested system permissions")
		return setupResult{}, nil
	}
	if _, err := h.configure("standby-on", true, never); err == nil {
		t.Fatal("enabled without desktop grant")
	}
	if err := h.save(nil, true, "control", "primary"); err != nil {
		t.Fatal(err)
	}
	raw, _ := h.read()
	id := readDecision(raw).ID
	if _, err := h.configure("standby-on", false, never); err == nil {
		t.Fatal("enabled without direct transport")
	}
	if _, err := h.configure("standby-on", true, never); err != nil {
		t.Fatal(err)
	}
	raw, _ = h.read()
	if g := readDecision(raw); g.ID != id || !g.Standby {
		t.Fatal(g)
	}
	if err := h.save(raw, false, "view", "primary"); err != nil {
		t.Fatal(err)
	}
	raw, _ = h.read()
	if !readDecision(raw).Standby {
		t.Fatal("reconfiguration lost standby")
	}
	if err := h.Disable(); err != nil {
		t.Fatal(err)
	}
	raw, _ = h.read()
	if readDecision(raw).Standby {
		t.Fatal("disabled grant retained standby")
	}
}

func TestLocalHostPolicyTracksPlatformSupport(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	wantSupported := Supported()

	p := h.Policy()
	if p.Supported != wantSupported || p.View || p.Control {
		t.Fatalf("unconfigured policy = %+v, want Supported=%v View=false Control=false", p, wantSupported)
	}

	if err := h.save(nil, true, "view", "primary"); err != nil {
		t.Fatal(err)
	}
	p = h.Policy()
	if p.Supported != wantSupported || p.View != wantSupported || p.Control {
		t.Fatalf("view policy = %+v, want Supported=%v View=%v Control=false", p, wantSupported, wantSupported)
	}

	if err := h.Disable(); err != nil {
		t.Fatal(err)
	}
	p = h.Policy()
	if p.Supported != wantSupported || p.View || p.Control {
		t.Fatalf("disabled policy = %+v, want Supported=%v View=false Control=false", p, wantSupported)
	}
}
