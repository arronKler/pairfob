package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Auto detection consults fixed system paths for Herdr. A machine that has one
// is not the environment these negative tests describe.
func skipWithSystemHerdr(t *testing.T) {
	t.Helper()
	for _, path := range []string{"/usr/local/bin/herdr", "/opt/homebrew/bin/herdr"} {
		if _, err := os.Stat(path); err == nil {
			t.Skipf("system Herdr at %s is detected", path)
		}
	}
}

func TestSelectRuntimeExplicit(t *testing.T) {
	t.Setenv("HERDR_SOCKET_PATH", "/tmp/pairfob-herdr.sock")
	t.Setenv("PAIRFOB_HC", "")

	t.Setenv("PAIRFOB_RUNTIME", "herdr")
	selection, err := SelectRuntime(false)
	if err != nil || selection.Kind != RuntimeKindHerdr || selection.Source != "herdr:/tmp/pairfob-herdr.sock" {
		t.Fatalf("selection=%+v err=%v", selection, err)
	}

	t.Setenv("PAIRFOB_RUNTIME", "core")
	selection, err = SelectRuntime(false)
	if err != nil || selection.Kind != RuntimeKindCore || selection.Source != "herdr-core:hc" || selection.Command != "hc" {
		t.Fatalf("selection=%+v err=%v", selection, err)
	}

	t.Setenv("PAIRFOB_RUNTIME", "HERDR-CORE")
	t.Setenv("PAIRFOB_HC", " /opt/hc ")
	selection, err = SelectRuntime(false)
	if err != nil || selection.Source != "herdr-core:/opt/hc" || selection.Command != "/opt/hc" {
		t.Fatalf("selection=%+v err=%v", selection, err)
	}

	t.Setenv("PAIRFOB_RUNTIME", "bogus")
	_, err = SelectRuntime(false)
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeInvalid || !strings.Contains(fault.SafeMessage, "herdr, core, or auto") {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}

func TestSelectRuntimeDevFake(t *testing.T) {
	t.Setenv("PAIRFOB_RUNTIME", "bogus")
	selection, err := SelectRuntime(true)
	if err != nil || selection.Kind != RuntimeKindFake || selection.Source != "fake:explicit-dev" {
		t.Fatalf("selection=%+v err=%v", selection, err)
	}
}

func TestSelectRuntimeAutoPrefersHerdrSocket(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "herdr.sock")
	if err := os.WriteFile(socket, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_SOCKET_PATH", socket)
	t.Setenv("PAIRFOB_RUNTIME", "auto")
	selection, err := SelectRuntime(false)
	if err != nil || selection.Kind != RuntimeKindHerdr || selection.Source != "herdr:"+socket {
		t.Fatalf("selection=%+v err=%v", selection, err)
	}
}

func TestSelectRuntimeAutoSelectsCore(t *testing.T) {
	skipWithSystemHerdr(t)
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
	selection, err := SelectRuntime(false)
	if err != nil || selection.Kind != RuntimeKindCore || selection.Command != hc || selection.Source != "herdr-core:"+hc {
		t.Fatalf("selection=%+v err=%v", selection, err)
	}
}

func TestSelectRuntimeAutoFindsNothing(t *testing.T) {
	skipWithSystemHerdr(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HERDR_BIN", "")
	t.Setenv("HERDR_SOCKET_PATH", filepath.Join(home, "herdr.sock"))
	t.Setenv("PAIRFOB_RUNTIME", "")
	t.Setenv("PAIRFOB_HC", "hc")
	_, err := SelectRuntime(false)
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeOffline || !strings.Contains(fault.SafeMessage, "no terminal runtime found") {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}

func TestOpenConfiguredKeepsHerdrFallback(t *testing.T) {
	skipWithSystemHerdr(t)
	home := t.TempDir()
	socket := filepath.Join(home, "herdr.sock")
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HERDR_BIN", "")
	t.Setenv("HERDR_SOCKET_PATH", socket)
	t.Setenv("PAIRFOB_RUNTIME", "")
	t.Setenv("PAIRFOB_HC", "hc")
	rt, source, err := OpenConfigured(false, false)
	if err != nil || source != "herdr:"+socket {
		t.Fatalf("runtime=%T source=%q err=%v", rt, source, err)
	}
	if _, ok := rt.(*Herdr); !ok {
		t.Fatalf("fallback runtime=%T", rt)
	}
}
