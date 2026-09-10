package runtime

import (
	"context"
	"errors"
	"os"
	goruntime "runtime"
	"strings"
	"testing"
)

func TestQuotaKeychainResultRejectsFailuresAndMalformedOutput(t *testing.T) {
	for _, raw := range []string{
		"", `{}`, `{"token":"secret"}`, `{"status":0}`, `{"status":-50,"token":"secret"}`,
		`{"status":-25293,"token":"secret"}`, `{"status":0,"token":"too-long-secret"}`,
	} {
		value, err := parseQuotaKeychainResult([]byte(raw), 6)
		if len(value) != 0 || err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid credential response was accepted or leaked")
		}
	}
	if _, err := parseQuotaKeychainResult([]byte(`{"status":-25300}`), 6); !errors.Is(err, errQuotaKeychainNotFound) {
		t.Fatal("missing credential not recognized")
	}
	if value, err := parseQuotaKeychainResult([]byte(`{"status":0,"token":"a\nb"}`), 3); err != nil || string(value) != "a\nb" {
		t.Fatal("valid credential bytes changed")
	}
}

// Opt-in integration check of JXA/CF bridging, using a nonexistent credential.
// No real login is read, no Keychain is created, and no dialog is allowed.
func TestQuotaKeychainNativeQuery(t *testing.T) {
	if goruntime.GOOS != "darwin" || os.Getenv("PAIRFOB_TEST_KEYCHAIN") != "1" {
		t.Skip("set PAIRFOB_TEST_KEYCHAIN=1 on macOS")
	}
	_, err := quotaKeychainRead(context.Background(), "pairfob-nonexistent-quota-test-credential", "pairfob-test", 16384)
	if !errors.Is(err, errQuotaKeychainNotFound) {
		t.Fatalf("native query failed instead of reporting missing item: %v", err)
	}
}
