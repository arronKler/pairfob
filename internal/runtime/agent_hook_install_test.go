//go:build darwin || linux

package runtime

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hookTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
	t.Setenv("CLINE_DIR", "")
	return home
}

func writeHookTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestAgentObservationInstallPreservesConfig(t *testing.T) {
	home := hookTestHome(t)
	binary := filepath.Join(home, "quoted ' path", "pairfob")
	gemini := filepath.Join(home, ".gemini", "settings.json")
	writeHookTestFile(t, gemini, `{"unknownSetting":9007199254740993,"hooks":{"SessionStart":[{"matcher":"resume","hooks":[{"name":"user-hook","type":"command","command":"echo keep"}]}]}}`)
	cline := filepath.Join(home, ".cline", "hooks", "TaskStart.sh")
	writeHookTestFile(t, cline, "#!/bin/sh\necho original\n")
	maki := filepath.Join(home, "xdg", "maki", "init.lua")
	if err := os.MkdirAll(filepath.Join(home, ".maki", "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	writeHookTestFile(t, maki, "maki.setup({})\nreturn\n")
	for _, agent := range []string{"gemini", "cline", "amp", "maki", "cmd"} {
		if err := InstallAgentObservation(agent, binary); err != nil {
			t.Fatalf("%s: %v", agent, err)
		}
	}
	data, _ := os.ReadFile(gemini)
	if !strings.Contains(string(data), "9007199254740993") || !strings.Contains(string(data), "echo keep") {
		t.Fatalf("lost user config: %s", data)
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	groups := settings["hooks"].(map[string]any)["SessionStart"].([]any)
	if len(groups) != 2 {
		t.Fatalf("hook groups: %d", len(groups))
	}
	command := groups[1].(map[string]any)["hooks"].([]any)[0].(map[string]any)["command"].(string)
	if command != shellQuoteHook(binary)+" agent-hook gemini" {
		t.Fatal(command)
	}
	original, _ := os.ReadFile(cline)
	if string(original) != "#!/bin/sh\necho original\n" {
		t.Fatal("replaced existing Cline hook")
	}
	added, _ := os.ReadFile(strings.TrimSuffix(cline, ".sh") + ".bash")
	if !strings.Contains(string(added), hookMarker) {
		t.Fatal("missing additive Cline hook")
	}
	makiData, _ := os.ReadFile(maki)
	if _, err := os.Stat(filepath.Join(home, ".maki", "init.lua")); !os.IsNotExist(err) {
		t.Fatal("shadowed existing Maki config with a legacy init")
	}
	if !strings.HasPrefix(string(makiData), "require(\"pairfob_session\")") || !strings.HasSuffix(string(makiData), "maki.setup({})\nreturn\n") {
		t.Fatalf("invalid Maki init: %s", makiData)
	}
	for _, agent := range []string{"gemini", "cline", "amp", "maki", "cmd"} {
		if err := InstallAgentObservation(agent, binary); err != nil {
			t.Fatal(err)
		}
	}
	again, _ := os.ReadFile(gemini)
	if !bytes.Equal(data, again) {
		t.Fatal("duplicate Gemini hooks")
	}
	again, _ = os.ReadFile(maki)
	if !bytes.Equal(makiData, again) {
		t.Fatal("duplicate Maki loader")
	}
}

func TestAgentObservationInstallFailsClosed(t *testing.T) {
	home := hookTestHome(t)
	path := filepath.Join(home, ".gemini", "settings.json")
	for _, body := range []string{"invalid", "[]", `{"hooks":false}`, `{"hooksConfig":{"enabled":false}}`} {
		writeHookTestFile(t, path, body)
		if err := InstallAgentObservation("gemini", "/safe/pairfob"); err == nil {
			t.Fatalf("accepted %s", body)
		}
		got, _ := os.ReadFile(path)
		if string(got) != body {
			t.Fatal("changed invalid/disabled settings")
		}
	}
	amp := filepath.Join(home, "xdg", "amp", "plugins", "pairfob-session.js")
	writeHookTestFile(t, amp, "user owned plugin")
	if err := InstallAgentObservation("amp", "/safe/pairfob"); err == nil {
		t.Fatal("overwrote user plugin")
	}
	if err := InstallAgentObservation("codex", "/safe/pairfob"); err == nil {
		t.Fatal("replaced native integration")
	}
}
