package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

type setupRuntimeFixture struct {
	states   []string
	starts   int
	startErr error
}

func (f *setupRuntimeFixture) CheckInstallation(context.Context) runtime.HerdrInstallation {
	state := f.states[0]
	if len(f.states) > 1 {
		f.states = f.states[1:]
	}
	return runtime.HerdrInstallation{State: state, Descriptor: runtime.Descriptor{Version: "0.8.2", Protocol: 20}}
}
func (f *setupRuntimeFixture) EnsureServer(context.Context) (runtime.HerdrServerAvailability, error) {
	f.starts++
	return runtime.HerdrServerAvailability{}, f.startErr
}

func TestSetupHerdrLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name                                             string
		states                                           []string
		explicit, disableStart, installFails, startFails bool
		wantInstalls, wantStarts                         int
		wantErr                                          bool
	}{
		{name: "ready reuse", states: []string{"ready"}, explicit: true},
		{name: "missing unattended without permission", states: []string{"missing"}, wantErr: true},
		{name: "missing declined", states: []string{"missing"}, wantErr: true},
		{name: "explicit install then start", states: []string{"missing", "stopped", "ready"}, explicit: true, wantInstalls: 1, wantStarts: 1},
		{name: "install with existing live server", states: []string{"missing", "ready"}, explicit: true, wantInstalls: 1},
		{name: "download failed", states: []string{"missing"}, explicit: true, installFails: true, wantInstalls: 1, wantErr: true},
		{name: "installed but still missing", states: []string{"missing", "missing"}, explicit: true, wantInstalls: 1, wantErr: true},
		{name: "stopped starts", states: []string{"stopped", "ready"}, wantStarts: 1},
		{name: "start failure", states: []string{"stopped"}, startFails: true, wantStarts: 1, wantErr: true},
		{name: "started but incompatible", states: []string{"stopped", "incompatible"}, wantStarts: 1, wantErr: true},
		{name: "autostart disabled", states: []string{"stopped"}, disableStart: true, wantErr: true},
		{name: "incompatible never replaced", states: []string{"incompatible"}, explicit: true, wantErr: true},
		{name: "unavailable never replaced", states: []string{"unavailable"}, explicit: true, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt := &setupRuntimeFixture{states: tc.states}
			if tc.startFails {
				rt.startErr = errors.New("failed to start")
			}
			installs := 0
			actions := herdrSetupActions{autostart: !tc.disableStart, install: func() error {
				installs++
				if tc.installFails {
					return errors.New("checksum mismatch")
				}
				return nil
			}}
			var out bytes.Buffer
			err := setupHerdr(rt, tc.explicit, actions, &out)
			if (err != nil) != tc.wantErr || installs != tc.wantInstalls || rt.starts != tc.wantStarts {
				t.Fatalf("err=%v installs=%d starts=%d output=%s", err, installs, rt.starts, out.String())
			}
			if tc.wantErr && strings.Contains(out.String(), "Herdr: ready") {
				t.Fatalf("claimed ready: %s", out.String())
			}
		})
	}
}

func TestSetupRejectsHerdrFlagsForCore(t *testing.T) {
	t.Setenv("PAIRFOB_RUNTIME", "core")
	for _, args := range [][]string{
		{"--install-herdr"},
		{"--no-install-herdr"},
		{"--update-herdr"},
		{"--update-herdr", "--restart-herdr"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			err := setupCommand(args)
			if err == nil || !strings.Contains(err.Error(), "PAIRFOB_RUNTIME=herdr") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestSetupTreatsNonInteractiveAsRuntimeNeutral(t *testing.T) {
	o, err := parseSetupOptions([]string{"--non-interactive"})
	if err != nil {
		t.Fatal(err)
	}
	if flags := o.herdrOnlyFlags(); len(flags) != 0 {
		t.Fatalf("non-interactive classified as Herdr-only: %v", flags)
	}
}

func TestSetupCoreRequiresRunnableClient(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-hc")
	t.Setenv("PAIRFOB_HC", missing)
	err := setupCore(runtime.RuntimeSelection{Kind: runtime.RuntimeKindCore, Command: missing}, true)
	if err == nil || !strings.Contains(err.Error(), "not runnable") {
		t.Fatalf("err=%v", err)
	}
}

func TestSetupAutoSelectsCoreWhenOnlyHCIsInstalled(t *testing.T) {
	for _, path := range []string{"/usr/local/bin/herdr", "/opt/homebrew/bin/herdr"} {
		if _, err := os.Stat(path); err == nil {
			t.Skipf("system Herdr at %s makes auto detection choose Herdr", path)
		}
	}
	commandDir := t.TempDir()
	hc := filepath.Join(commandDir, "hc")
	if err := os.WriteFile(hc, []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", commandDir)
	t.Setenv("HERDR_BIN", "")
	t.Setenv("HERDR_SOCKET_PATH", filepath.Join(home, "herdr.sock"))
	t.Setenv("PAIRFOB_RUNTIME", "")
	t.Setenv("PAIRFOB_HC", "hc")
	selection, auto, err := setupRuntimeSelection()
	if err != nil || !auto || selection.Kind != runtime.RuntimeKindCore || selection.Command != hc {
		t.Fatalf("selection=%+v auto=%v err=%v", selection, auto, err)
	}
}

func TestSetupFallsBackToHerdrWhenDetectionFindsNothing(t *testing.T) {
	for _, path := range []string{"/usr/local/bin/herdr", "/opt/homebrew/bin/herdr"} {
		if _, err := os.Stat(path); err == nil {
			t.Skipf("system Herdr at %s is detected", path)
		}
	}
	home := t.TempDir()
	empty := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", empty)
	t.Setenv("HERDR_BIN", "")
	t.Setenv("HERDR_SOCKET_PATH", filepath.Join(home, "herdr.sock"))
	t.Setenv("PAIRFOB_RUNTIME", "")
	t.Setenv("PAIRFOB_HC", "hc")
	selection, auto, err := setupRuntimeSelection()
	if err != nil || !auto || selection.Kind != runtime.RuntimeKindHerdr {
		t.Fatalf("selection=%+v auto=%v err=%v", selection, auto, err)
	}
}
