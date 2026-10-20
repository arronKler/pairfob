package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeQuotaSetupPreservesStatusline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	original := `{"permissions":{"deny":["Read(.env)"]},"statusLine":{"type":"command","command":"cat","padding":2}}`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installClaudeQuota(path, "/tmp/Pairfob's bin/pairfob"); err != nil {
		t.Fatal(err)
	}
	backup, _ := os.ReadFile(path + ".pairfob-backup")
	if string(backup) != original {
		t.Fatal("backup altered")
	}
	updated, _ := os.ReadFile(path)
	var settings map[string]json.RawMessage
	_ = json.Unmarshal(updated, &settings)
	if string(settings["permissions"]) == "null" {
		t.Fatal("lost permissions")
	}
	var line struct {
		Command string
		Padding int
	}
	_ = json.Unmarshal(settings["statusLine"], &line)
	if line.Padding != 2 || !strings.Contains(line.Command, " quota-statusline 'cat'") {
		t.Fatalf("%+v", line)
	}
	if err := installClaudeQuota(path, "/tmp/Pairfob's bin/pairfob"); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if !bytes.Equal(updated, second) {
		t.Fatal("setup not idempotent")
	}
}

func TestClaudeStatuslineCachesOnlyQuotaAndChainsOriginal(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	raw := `{"private":"do not cache","rate_limits":{"five_hour":{"used_percentage":25,"resets_at":2100000000}}}`
	var out bytes.Buffer
	if err := quotaStatusline([]string{"cat"}, strings.NewReader(raw), &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != raw {
		t.Fatal("previous statusline did not receive original input")
	}
	path := filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "pairfob-quota.json")
	cached, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cached), "private") || strings.Contains(string(cached), "do not cache") {
		t.Fatal("private payload cached")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("cache not private")
	}
	out.Reset()
	if err := quotaStatusline(nil, strings.NewReader(`{}`), &out); err != nil {
		t.Fatal(err)
	}
	cached, _ = os.ReadFile(path)
	if !strings.Contains(string(cached), `"status":"unavailable"`) {
		t.Fatal("previous quota survived absent limits")
	}
}

func TestQuotaShellQuote(t *testing.T) {
	value := "/tmp/a'b $(touch never) `echo nope`"
	out, err := exec.Command("sh", "-c", "printf '%s' "+shellQuotaQuote(value)).Output()
	if err != nil || string(out) != value {
		t.Fatalf("%q %v", out, err)
	}
}

func TestClaudeStatuslineOversizeStillReachesPreviousCommand(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	raw := strings.Repeat("x", 1024*1024+100)
	var out bytes.Buffer
	if err := quotaStatusline([]string{"cat"}, strings.NewReader(raw), &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != raw {
		t.Fatal("large previous statusline input truncated")
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("CLAUDE_CONFIG_DIR"), "pairfob-quota.json")); !os.IsNotExist(err) {
		t.Fatal("oversized input cached")
	}
}

func TestAntigravityQuotaSetupPreservesStatusline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	original := `{"model":"Gemini 4 Argon (High)","statusLine":{"type":"command","command":"agy-statusline","enabled":true}}`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installSettingsQuota(path, "/tmp/pairfob", "Antigravity"); err != nil {
		t.Fatal(err)
	}
	backup, _ := os.ReadFile(path + ".pairfob-backup")
	if string(backup) != original {
		t.Fatal("backup altered")
	}
	updated, _ := os.ReadFile(path)
	var settings map[string]json.RawMessage
	_ = json.Unmarshal(updated, &settings)
	if string(settings["model"]) != `"Gemini 4 Argon (High)"` {
		t.Fatal("lost model setting")
	}
	var line struct {
		Command string `json:"command"`
		Enabled bool   `json:"enabled"`
	}
	_ = json.Unmarshal(settings["statusLine"], &line)
	if !line.Enabled || !strings.Contains(line.Command, " quota-statusline 'agy-statusline'") {
		t.Fatalf("%+v", line)
	}
}

func TestAntigravityStatuslineCachesQuotaWithArgonPool(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ANTIGRAVITY_CONFIG_DIR", dir)
	raw := `{"cwd":"/secret/path","product":"antigravity","plan_tier":"Google AI Pro","quota":{"gemini-5h":{"remaining_fraction":0.85,"reset_time":"2027-01-01T00:00:00Z"},"gemini-argon-wtu-weekly":{"remaining_fraction":0.10,"reset_time":"2027-01-07T00:00:00Z"},"3p-weekly":{"remaining_fraction":0.50,"reset_time":"2027-01-07T00:00:00Z"}}}`
	var out bytes.Buffer
	if err := quotaStatusline([]string{"cat"}, strings.NewReader(raw), &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != raw {
		t.Fatal("previous command didn't get original raw input")
	}
	path := filepath.Join(dir, "pairfob-quota.json")
	cached, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cached), "secret") {
		t.Fatal("secret path leaked into quota cache")
	}
	var q struct {
		Provider string `json:"provider"`
		Plan     string `json:"plan"`
		Windows  []struct {
			Name        string  `json:"name"`
			UsedPercent float64 `json:"used_percent"`
		} `json:"windows"`
	}
	if err := json.Unmarshal(cached, &q); err != nil {
		t.Fatal(err)
	}
	if q.Provider != "antigravity" || q.Plan != "Google AI Pro" || len(q.Windows) != 3 {
		t.Fatalf("%+v", q)
	}
	foundArgon := false
	for _, w := range q.Windows {
		if strings.Contains(w.Name, "Argon") {
			foundArgon = true
			if w.UsedPercent < 89 || w.UsedPercent > 91 {
				t.Fatalf("argon used percent: %f", w.UsedPercent)
			}
		}
	}
	if !foundArgon {
		t.Fatal("Gemini Argon window not found in cache")
	}
}
