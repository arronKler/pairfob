package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"
)

func cursorTestToken(subject string, expires int64) string {
	raw, _ := json.Marshal(map[string]any{"sub": subject, "exp": expires})
	return "header." + base64.RawURLEncoding.EncodeToString(raw) + ".signature"
}

func cursorTestAuthFile(t *testing.T, raw string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
	t.Setenv("APPDATA", filepath.Join(home, "appdata"))
	for _, name := range []string{"CURSOR_AUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_API_ENDPOINT", "PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN"} {
		t.Setenv(name, "")
	}
	t.Setenv("AGENT_CLI_CREDENTIAL_STORE", "file")
	path := cursorQuotaAuthPath(goruntime.GOOS, home, os.Getenv("XDG_CONFIG_HOME"), os.Getenv("APPDATA"))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if raw != "" {
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestCursorQuotaFollowsCLICredentialStore(t *testing.T) {
	for _, tc := range []struct{ platform, mode, want string }{
		{"darwin", "", "keychain"}, {"darwin", "default", "keychain"},
		{"darwin", "file", "file"}, {"darwin", "memory", "memory"},
		{"linux", "", "file"}, {"linux", "memory", "memory"},
		{"windows", "", "file"}, {"darwin", "unknown", "keychain"},
	} {
		if got := cursorQuotaStore(tc.platform, tc.mode); got != tc.want {
			t.Errorf("%s/%s: %s, want %s", tc.platform, tc.mode, got, tc.want)
		}
	}
	for _, tc := range []struct{ platform, xdg, appdata, want string }{
		{"darwin", "xdg", "appdata", "home/.cursor/auth.json"},
		{"linux", "", "", "home/.config/cursor/auth.json"},
		{"linux", "xdg", "", "xdg/cursor/auth.json"},
		{"windows", "", "", "home/AppData/Roaming/Cursor/auth.json"},
		{"windows", "", "appdata", "appdata/Cursor/auth.json"},
	} {
		if got := cursorQuotaAuthPath(tc.platform, "home", tc.xdg, tc.appdata); got != filepath.FromSlash(tc.want) {
			t.Errorf("%s: %s, want %s", tc.platform, got, tc.want)
		}
	}
}

func TestCursorQuotaReadsOnlyCLIFileWithoutCommandsOrWrites(t *testing.T) {
	token := cursorTestToken("auth0|user_cli", time.Now().Unix()+3600)
	raw, _ := json.Marshal(map[string]string{"accessToken": token, "refreshToken": "do-not-use", "apiKey": "saved-key"})
	path := cursorTestAuthFile(t, string(raw))
	t.Setenv("PATH", t.TempDir())
	t.Setenv("CURSOR_CONFIG_DIR", t.TempDir())
	got, status := cursorQuotaToken(context.Background())
	if status != "" || got != token {
		t.Fatalf("CLI credentials were not read: status=%s", status)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(raw) {
		t.Fatal("CLI credentials were modified")
	}
	if cookie := cursorQuotaCookie(got, time.Now()); !strings.HasPrefix(cookie, "WorkosCursorSessionToken=user_cli%3A%3A") {
		t.Fatal("CLI login was not converted to a Cursor session")
	}
}

func TestCursorQuotaDoesNotBorrowAnotherAccount(t *testing.T) {
	token := cursorTestToken("user_saved", time.Now().Unix()+3600)
	raw, _ := json.Marshal(map[string]string{"accessToken": token})
	cursorTestAuthFile(t, string(raw))
	t.Setenv("AGENT_CLI_CREDENTIAL_STORE", "memory")
	if q := readCursorQuota(context.Background()); q.Status != "auth_required" || len(q.Windows) != 0 {
		t.Fatalf("memory store borrowed disk login: %+v", q)
	}
	t.Setenv("AGENT_CLI_CREDENTIAL_STORE", "file")
	t.Setenv("PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN", "1")
	if q := readCursorQuota(context.Background()); q.Status != "unsupported" {
		t.Fatal("installed service borrowed a saved account after dropping explicit credentials")
	}
	t.Setenv("PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN", "")
	t.Setenv("CURSOR_API_KEY", "another-account-key")
	if q := readCursorQuota(context.Background()); q.Status != "unsupported" {
		t.Fatal("API-key account borrowed disk login")
	}
	t.Setenv("CURSOR_AUTH_TOKEN", "expired-or-invalid-override")
	if q := readCursorQuota(context.Background()); q.Status != "auth_required" {
		t.Fatal("invalid explicit login fell back to a saved account")
	}
	t.Setenv("CURSOR_AUTH_TOKEN", token)
	t.Setenv("PAIRFOB_CURSOR_QUOTA_NO_STORED_LOGIN", "1")
	if got, status := cursorQuotaToken(context.Background()); status != "" || got != token {
		t.Fatal("explicit auth token did not take precedence")
	}
	t.Setenv("CURSOR_API_ENDPOINT", "https://custom.example")
	if q := readCursorQuota(context.Background()); q.Status != "unsupported" {
		t.Fatal("custom endpoint login could be sent to Cursor")
	}
}

func TestCursorQuotaInvalidCLIFileNeverBecomesAnAllowance(t *testing.T) {
	for _, tc := range []struct{ name, raw string }{
		{"missing", ""}, {"malformed", "{"}, {"empty", `{}`}, {"null", `null`},
		{"wrong token type", `{"accessToken":42}`}, {"refresh only", `{"refreshToken":"only-refresh"}`},
		{"invalid token", `{"accessToken":"invalid"}`},
		{"expired", `{"accessToken":"` + cursorTestToken("user", time.Now().Unix()-1) + `"}`},
		{"oversized", strings.Repeat(" ", 1024*1024+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cursorTestAuthFile(t, tc.raw)
			q := readCursorQuota(context.Background())
			want := "auth_required"
			if tc.name == "missing" {
				want = "not_logged_in"
			}
			if q.Status != want || len(q.Windows) != 0 || q.ObservedAt != 0 {
				t.Fatalf("invalid login was not rejected: %+v", q)
			}
		})
	}
	cursorTestAuthFile(t, `{"apiKey":"only-api-key"}`)
	if q := readCursorQuota(context.Background()); q.Status != "unsupported" {
		t.Fatal("API key was treated as an access token")
	}
}

func TestCursorQuotaRejectsSymlinkCredentials(t *testing.T) {
	path := cursorTestAuthFile(t, "")
	target := filepath.Join(t.TempDir(), "auth.json")
	_ = os.WriteFile(target, []byte(`{"accessToken":"other-account"}`), 0600)
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if token, status := cursorQuotaToken(context.Background()); token != "" || status != "auth_required" {
		t.Fatal("symlink credential accepted")
	}
}

func TestCursorQuotaRejectsMalformedOrExpiringTokens(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, token := range []string{
		"", "invalid", "header.!.signature", strings.Repeat("a", 16385),
		cursorTestToken("user", now.Unix()+60), cursorTestToken("", now.Unix()+3600),
		cursorTestToken("user;other", now.Unix()+3600), cursorTestToken("auth0|", now.Unix()+3600),
	} {
		if cursorQuotaCookie(token, now) != "" {
			t.Fatal("invalid or expiring login accepted")
		}
	}
}

func TestCursorQuotaReadsIncludedPlanWithoutInventingReset(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, body := range []string{`{"membershipType":"pro","individualUsage":{"plan":{"enabled":true,"totalPercentUsed":25}}}`, `{"membershipType":"pro","individualUsage":{"plan":{"used":500,"limit":2000}}}`} {
		q := parseCursorQuota([]byte(body), now)
		if q.Status != "ok" || q.Windows[0].UsedPercent != 25 || q.Windows[0].ResetsAt != 0 {
			t.Fatalf("%+v", q)
		}
	}
	for _, body := range []string{`{}`, `{"individualUsage":{"plan":{"enabled":false,"totalPercentUsed":0}}}`, `{"individualUsage":{"plan":{"used":0,"limit":0}}}`} {
		if q := parseCursorQuota([]byte(body), now); q.Status != "unavailable" {
			t.Fatalf("%+v", q)
		}
	}
}

func TestCursorQuotaUsesOnlyFixedReadOnlyEndpoint(t *testing.T) {
	now := time.Unix(1800000000, 0)
	token := cursorTestToken("user_cli", now.Unix()+3600)
	cookie := cursorQuotaCookie(token, now)
	for _, code := range []int{200, 401, 403, 429} {
		calls := 0
		client := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Method != "GET" || r.URL.String() != "https://cursor.com/api/usage-summary" || (r.Body != nil && r.Body != http.NoBody) || r.Header.Get("Cookie") != cookie || r.Header.Get("Authorization") != "" {
				t.Fatal("incorrect credential-bearing request")
			}
			body := `{"individualUsage":{"plan":{"totalPercentUsed":25}}}`
			return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
		})}
		q := fetchCursorQuota(context.Background(), client, cookie, now)
		want := map[int]string{200: "ok", 401: "auth_required", 403: "auth_required", 429: "unavailable"}[code]
		if calls != 1 || q.Status != want {
			t.Fatalf("HTTP %d: calls=%d, quota=%+v", code, calls, q)
		}
		raw, _ := json.Marshal(q)
		if strings.Contains(string(raw), token) || strings.Contains(string(raw), "WorkosCursorSessionToken") {
			t.Fatal("credential leaked into quota result")
		}
	}
}
