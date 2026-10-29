package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCodeObservationRequiresPaneLocalPlugin(t *testing.T) {
	for _, version := range []string{"1.1.28", "1.18.28", "unknown", "1.19", "-1.19.5", "1.19.5\nwarning"} {
		if supportsOpenCodeTUI(version) {
			t.Fatal(version)
		}
	}
	for _, version := range []string{"1.18.29", "1.19.5", "v1.19.5", "2.0.0-beta.19242"} {
		if !supportsOpenCodeTUI(version) {
			t.Fatal(version)
		}
	}
	if os.PathSeparator == '\\' {
		t.Skip("shell fixture")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "config"))
	t.Setenv("PATH", home)
	binary := filepath.Join(home, "opencode")
	write := func(version string) {
		t.Helper()
		if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	installs := 0
	socket, _ := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply {
		if req.Method == "integration.install" {
			installs++
			return scriptedReply{Result: map[string]any{"type": "ok"}}
		}
		return standardReply(req)
	})
	h := NewHerdr(socket)
	write("1.1.28")
	if h.prepareOpenCodeObservation(context.Background(), SessionRef{}) == nil || installs != 0 {
		t.Fatal("installed incompatible plugin")
	}
	write("1.19.5")
	if err := h.prepareOpenCodeObservation(context.Background(), SessionRef{}); err != nil || installs != 1 {
		t.Fatalf("prepare: %v installs=%d", err, installs)
	}
}
