package main

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceRetainsCheckedHerdrEnvironment(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "herdr & test")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_BIN", binary)
	t.Setenv("HERDR_SOCKET_PATH", "relative/herdr.sock")
	t.Setenv("HERDR_CONFIG_PATH", "/tmp/herdr & test/config.toml")
	t.Setenv("PAIRFOB_HERDR_AUTOSTART", "0")
	t.Setenv("PAIRFOB_MULTI_SESSION", "1")
	t.Setenv("HERDR_ENV", "1")
	t.Setenv("HERDR_PANE_ID", "forbidden-pane-identity")
	t.Setenv("PAIRFOB_RECONNECT_TOKEN", "forbidden-credential")
	env := map[string]string{}
	for _, entry := range serviceRuntimeEnvironment() {
		env[entry[0]] = entry[1]
	}
	absolute, _ := filepath.Abs("relative/herdr.sock")
	if env["HERDR_BIN"] != binary || env["HERDR_SOCKET_PATH"] != absolute || env["PAIRFOB_HERDR_AUTOSTART"] != "0" || env["PAIRFOB_MULTI_SESSION"] != "1" {
		t.Fatalf("env=%v", env)
	}
	plist := launchdPlist("/tmp/pairfob", "/tmp/log", "/tmp")
	var parsed any
	if err := xml.Unmarshal([]byte(plist), &parsed); err != nil {
		t.Fatal(err)
	}
	unit := systemdUnitFile("/tmp/pairfob", "/tmp/log", "/tmp")
	for _, body := range []string{plist, unit} {
		for _, forbidden := range []string{"HERDR_ENV", "forbidden-pane-identity", "forbidden-credential"} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("leaked %s", forbidden)
			}
		}
	}
	if !strings.Contains(plist, xmlEscape(binary)) || !strings.Contains(unit, "Environment=HERDR_BIN="+systemdEnvironmentValue(binary)) {
		t.Fatal("service omitted checked executable")
	}
	if !strings.Contains(unit, "Environment=HERDR_SOCKET_PATH="+systemdEnvironmentValue(absolute)) {
		t.Fatal("service changed socket")
	}
}

func TestServiceRuntimeEscapesSystemdSpecifiersAndNewlines(t *testing.T) {
	t.Setenv("HERDR_CONFIG_PATH", "/tmp/%h/config\nInjected=value")
	body := systemdRuntimeEnvironment()
	if strings.Contains(body, "\nInjected=value") || !strings.Contains(body, `/tmp/%%h/config\nInjected=value`) {
		t.Fatalf("unsafe environment: %s", body)
	}
}

func TestServiceKeepsInvalidExplicitHerdrOverrideForDiagnosis(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("HERDR_BIN", "missing/herdr")
	for _, entry := range serviceRuntimeEnvironment() {
		if entry[0] == "HERDR_BIN" {
			if entry[1] != "missing/herdr" {
				t.Fatalf("invalid override changed: %v", entry)
			}
			return
		}
	}
	t.Fatal("explicit invalid override silently removed")
}
