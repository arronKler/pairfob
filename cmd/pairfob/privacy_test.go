package main

import (
	"bytes"
	"strings"
	"testing"

	"pairfob/internal/admin"
)

func TestPrivacyReportExplainsPausedReadsWithoutProbing(t *testing.T) {
	var out bytes.Buffer
	writePrivacyReport(&out, admin.Privacy{
		Executable: "/home/me/.local/bin/pairfob", Providers: []string{"cursor"}, NativeKeychain: true,
		Keychain: []admin.KeychainAccess{{Provider: "cursor", State: "interaction_required", UpdatedAt: 100, Paused: true}},
	})
	for _, want := range []string{"/home/me/.local/bin/pairfob", "silent native reads", "interaction_required", "pairfob quota authorize cursor"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q: %s", want, out.String())
		}
	}
}

func TestQuotaSelectionSurvivesServiceInstall(t *testing.T) {
	t.Setenv("PAIRFOB_QUOTA_PROVIDERS", "codex,cursor")
	found := false
	for _, row := range serviceRuntimeEnvironment() {
		if row[0] == "PAIRFOB_QUOTA_PROVIDERS" {
			found = true
			if row[1] != "codex,cursor" {
				t.Fatal(row)
			}
		}
	}
	if !found {
		t.Fatal("service lost quota selection")
	}
}

func TestQuotaLocalActionsRejectUnknownProviderWithoutReading(t *testing.T) {
	for _, action := range []string{"authorize", "retry"} {
		if err := quotaCLI([]string{action, "unknown"}, &bytes.Buffer{}); err == nil {
			t.Fatalf("%s accepted unknown provider", action)
		}
	}
}
