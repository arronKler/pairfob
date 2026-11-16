package runtime

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// factorySeal builds the CLI's own `iv:tag:ciphertext` envelope with a 16-byte
// nonce, which is what the real store uses.
func factorySeal(t *testing.T, key, plain []byte) string {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	iv := make([]byte, 16)
	if _, err := rand.Read(iv); err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, iv, plain, nil)
	body, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	return base64.StdEncoding.EncodeToString(iv) + ":" + base64.StdEncoding.EncodeToString(tag) + ":" + base64.StdEncoding.EncodeToString(body)
}

// factoryFixture writes an encrypted login and stubs the keychain key.
func factoryFixture(t *testing.T, login string) (string, []byte) {
	t.Helper()
	dir := t.TempDir()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	sealed := factorySeal(t, key, []byte(login))
	if err := os.WriteFile(filepath.Join(dir, "auth.v2.loginkeychain"), []byte(sealed), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := quotaKeychainReadAs
	t.Cleanup(func() { quotaKeychainReadAs = restore })
	quotaKeychainReadAs = func(_ context.Context, provider, service, account string, _ int) ([]byte, error) {
		if provider != "factory" || service != "Factory CLI" {
			t.Errorf("unexpected keychain read: %s %s %s", provider, service, account)
		}
		return []byte(base64.StdEncoding.EncodeToString(key)), nil
	}
	return dir, key
}

func TestFactoryWindowsBecomePlanMeters(t *testing.T) {
	now := time.Unix(1800000000, 0)
	dir, _ := factoryFixture(t, `{"access_token":"factory-test-token","active_organization_id":"org-1"}`)
	body := `{"hasActiveSubscription":true,"limits":{"standard":{
		"fiveHour":{"usedPercent":40,"windowEnd":"2027-01-16T09:00:00Z"},
		"weekly":{"usedPercent":12.5,"windowEnd":"2027-01-20T09:00:00Z"},
		"monthly":null}}}`
	c := quotaFixtureClient(t, "api.factory.ai", "/api/billing/limits", "Bearer factory-test-token", 200, body)
	a := fetchFactoryQuota(context.Background(), c, dir, now)
	if a.ID != "factory" || a.Provider != "factory" || a.Source != "api" || a.State != "ok" || len(a.Meters) != 2 {
		t.Fatalf("%+v", a)
	}
	if m := a.Meters[0]; m.Name != "five hour" || m.Pool != "plan" || !m.Headline || *m.UsedPercent != 40 || m.WindowMinutes != 300 || m.ResetsAt == 0 {
		t.Fatalf("%+v", m)
	}
	if m := a.Meters[1]; m.Name != "seven day" || *m.UsedPercent != 12.5 || m.WindowMinutes != 10080 {
		t.Fatalf("%+v", m)
	}
}

func TestFactoryParsingFailsClosed(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, body := range []string{
		`{}`,
		`{"hasActiveSubscription":true}`,
		`{"hasActiveSubscription":true,"limits":{"standard":{}}}`,
		`{"hasActiveSubscription":true,"limits":{"standard":{"fiveHour":{"usedPercent":140}}}}`,
		`{"hasActiveSubscription":true,"limits":{"standard":{"fiveHour":{"usedPercent":-1}}}}`,
	} {
		if a := parseFactoryQuota([]byte(body), now); a.State != "failed" || a.Reason != "unavailable" || len(a.Meters) != 0 || a.ObservedAt != 0 {
			t.Fatalf("%s: %+v", body, a)
		}
	}
	// No subscription is a login without an allowance, not zero usage and not
	// a login to renew.
	none := `{"hasActiveSubscription":false}`
	if a := parseFactoryQuota([]byte(none), now); a.State != "not_configured" || a.Reason != "unsupported_login" || len(a.Meters) != 0 {
		t.Fatalf("%+v", a)
	}
}

func TestFactoryDecryptRejectsForeignEnvelopes(t *testing.T) {
	key := make([]byte, 32)
	good := factorySeal(t, key, []byte(`{"access_token":"factory-test-token"}`))
	if plain, err := factoryDecrypt(good, key); err != nil || !strings.Contains(string(plain), "factory-test-token") {
		t.Fatalf("%v %s", err, plain)
	}
	other := make([]byte, 32)
	other[0] = 1
	for name, raw := range map[string]string{
		"wrong key":   good,
		"no envelope": "not-an-envelope",
		"two parts":   "a:b",
		"bad base64":  "!!!:!!!:!!!",
		"empty body":  base64.StdEncoding.EncodeToString(make([]byte, 16)) + ":" + base64.StdEncoding.EncodeToString(make([]byte, 16)) + ":",
	} {
		use := key
		if name == "wrong key" {
			use = other
		}
		if _, err := factoryDecrypt(raw, use); err == nil {
			t.Fatalf("%s: decrypted", name)
		}
	}
}

func TestFactoryLoginProblemsAreStates(t *testing.T) {
	now := time.Unix(1800000000, 0)
	// No store at all is no login.
	if a := fetchFactoryQuota(context.Background(), quotaHTTPClient(), t.TempDir(), now); a.State != "not_configured" || a.Reason != "no_login" {
		t.Fatalf("%+v", a)
	}
	// A store that will not open is a login to renew, never a number.
	dir, _ := factoryFixture(t, `{"access_token":"factory-test-token"}`)
	if err := os.WriteFile(filepath.Join(dir, "auth.v2.loginkeychain"), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if a := fetchFactoryQuota(context.Background(), quotaHTTPClient(), dir, now); a.State != "needs_action" || a.Reason != "relogin" {
		t.Fatalf("%+v", a)
	}
	// A denied keychain read is the user's to allow, not a broken login.
	dir2, _ := factoryFixture(t, `{"access_token":"factory-test-token"}`)
	quotaKeychainReadAs = func(context.Context, string, string, string, int) ([]byte, error) {
		return nil, errQuotaKeychainInteraction
	}
	if a := fetchFactoryQuota(context.Background(), quotaHTTPClient(), dir2, now); a.State != "needs_action" || a.Reason != "allow_keychain" {
		t.Fatalf("%+v", a)
	}
}

func TestFactoryHTTPStatusesAreStates(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for code, want := range map[int]struct{ state, reason string }{
		401: {state: "needs_action", reason: "relogin"},
		403: {state: "not_configured", reason: "unsupported_login"},
		500: {state: "failed", reason: "unavailable"},
	} {
		dir, _ := factoryFixture(t, `{"access_token":"factory-test-token"}`)
		c := quotaFixtureClient(t, "api.factory.ai", "/api/billing/limits", "Bearer factory-test-token", code, `{}`)
		a := fetchFactoryQuota(context.Background(), c, dir, now)
		if a.State != want.state || a.Reason != want.reason {
			t.Fatalf("%d: %+v", code, a)
		}
	}
}

func TestFactoryMissingDirectoryIsNotInstalled(t *testing.T) {
	t.Setenv("FACTORY_HOME", filepath.Join(t.TempDir(), "absent"))
	if _, status := factoryConfigDir(); status != "not_installed" {
		t.Fatalf("status %q", status)
	}
}
