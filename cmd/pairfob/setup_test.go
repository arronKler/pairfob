package main

import (
	"bytes"
	"context"
	"errors"
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
		name                                                                string
		states                                                              []string
		explicit, consent, noPrompt, disableStart, installFails, startFails bool
		wantInstalls, wantStarts, wantPrompts                               int
		wantErr                                                             bool
	}{
		{name: "ready reuse", states: []string{"ready"}, explicit: true},
		{name: "missing unattended without permission", states: []string{"missing"}, noPrompt: true, wantErr: true},
		{name: "missing declined", states: []string{"missing"}, wantPrompts: 1, wantErr: true},
		{name: "explicit install then start", states: []string{"missing", "stopped", "ready"}, explicit: true, wantInstalls: 1, wantStarts: 1},
		{name: "consent install then start", states: []string{"missing", "stopped", "ready"}, consent: true, wantInstalls: 1, wantStarts: 1, wantPrompts: 1},
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
			installs, prompts := 0, 0
			actions := herdrSetupActions{autostart: !tc.disableStart, install: func() error {
				installs++
				if tc.installFails {
					return errors.New("checksum mismatch")
				}
				return nil
			}}
			if !tc.noPrompt {
				actions.confirm = func() bool { prompts++; return tc.consent }
			}
			var out bytes.Buffer
			err := setupHerdr(rt, tc.explicit, actions, &out)
			if (err != nil) != tc.wantErr || installs != tc.wantInstalls || rt.starts != tc.wantStarts || prompts != tc.wantPrompts {
				t.Fatalf("err=%v installs=%d starts=%d prompts=%d output=%s", err, installs, rt.starts, prompts, out.String())
			}
			if tc.wantErr && strings.Contains(out.String(), "Herdr: ready") {
				t.Fatalf("claimed ready: %s", out.String())
			}
		})
	}
}
