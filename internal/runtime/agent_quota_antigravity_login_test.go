package runtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"
)

func TestAntigravityLoginIsFoundByNameAndJudgedByExpiry(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	fresh := now.Add(40 * time.Minute).Format(time.RFC3339)
	old := now.Add(-time.Minute).Format(time.RFC3339)
	wrapped := "go-keyring-base64:" + base64.StdEncoding.EncodeToString([]byte(`{"access_token":"tok","expiry":"`+fresh+`"}`))
	for name, c := range map[string]struct{ raw, token, status string }{
		"flat":           {`{"access_token":"tok","refresh_token":"r","expiry":"` + fresh + `"}`, "tok", ""},
		"camel case":     {`{"accessToken":"tok","expiresAt":` + jsonNumber(now.Add(time.Hour).UnixMilli()) + `}`, "tok", ""},
		"one level down": {`{"email":"a@b.c","token":{"access_token":"tok","expiry":"` + fresh + `"}}`, "tok", ""},
		"JSON in a text": {`{"token":"{\"access_token\":\"tok\",\"expiry\":\"` + fresh + `\"}"}`, "tok", ""},
		"wrapped":        {wrapped, "tok", ""},
		"no expiry":      {`{"access_token":"tok"}`, "tok", ""},
		"expired":        {`{"access_token":"tok","expiry":"` + old + `"}`, "", "auth_required"},
		"about to":       {`{"access_token":"tok","expiry":` + jsonNumber(now.Add(30*time.Second).Unix()) + `}`, "", "auth_required"},
		"no token":       {`{"refresh_token":"r"}`, "", "unavailable"},
		"not JSON":       {`ya29.something`, "", "unavailable"},
		"bad wrapping":   {`go-keyring-base64:%%%`, "", "unavailable"},
		"oversized":      {`{"access_token":"` + strings.Repeat("x", 16385) + `"}`, "", "unavailable"},
	} {
		token, status := parseAntigravityLogin([]byte(c.raw), now)
		if token != c.token || status != c.status {
			t.Errorf("%s: token %q status %q", name, token, status)
		}
	}
}

func jsonNumber(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

// Without a keyring the CLI keeps its login in a private file; that file is
// the login on Linux, and on macOS when the keyring holds none.
func TestAntigravityStoredLoginReadsTheCLIFile(t *testing.T) {
	if goruntime.GOOS == "darwin" {
		t.Skip("the keyring is read first on macOS")
	}
	now := time.Now()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if token, status := antigravityStoredLogin(context.Background(), now); token != "" || status != "" {
		t.Fatalf("no file: token %q status %q", token, status)
	}
	dir := filepath.Join(home, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "antigravity-oauth-token")
	write := func(raw string) {
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fresh := now.Add(40 * time.Minute).UTC().Format(time.RFC3339)
	write(`{"auth_method":"oauth","id_token":"x","token":{"access_token":"tok","refresh_token":"r","token_type":"Bearer","expiry":"` + fresh + `"}}`)
	if token, status := antigravityStoredLogin(context.Background(), now); token != "tok" || status != "" {
		t.Fatalf("fresh: token %q status %q", token, status)
	}
	write(`{"token":{"access_token":"tok","expiry":"` + now.Add(-time.Minute).UTC().Format(time.RFC3339) + `"}}`)
	if token, status := antigravityStoredLogin(context.Background(), now); token != "" || status != "auth_required" {
		t.Fatalf("expired: token %q status %q", token, status)
	}
	// A path that is not a regular file is a read that failed, not no login.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if token, status := antigravityStoredLogin(context.Background(), now); token != "" || status != "unavailable" {
		t.Fatalf("not a file: token %q status %q", token, status)
	}
}

func TestAntigravityCloudQuotaAsksForTheTierThenTheSummary(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	reset := now.Add(3 * time.Hour).UTC().Format(time.RFC3339)
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		asked = append(asked, r.URL.Path+" "+string(body))
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("request: %s %q", r.Method, r.Header.Get("Authorization"))
		}
		if r.Header.Get("User-Agent") != antigravityUserAgent {
			t.Errorf("user agent: %q", r.Header.Get("User-Agent"))
		}
		switch r.URL.Path {
		case "/v1internal:loadCodeAssist":
			_, _ = w.Write([]byte(`{"cloudaicompanionProject":"proj-1","currentTier":{"name":"Free"},"paidTier":{"name":"Google AI Pro"}}`))
		case "/v1internal:retrieveUserQuotaSummary":
			_, _ = w.Write([]byte(`{"groups":[{"displayName":"Gemini","buckets":[{"bucketId":"pro","displayName":"Pro","remainingFraction":0.25,"resetTime":"` + reset + `"}]}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	q := fetchAntigravityCloudQuota(context.Background(), server.Client(), server.URL+"/v1internal:", "tok", now)
	if q.Status != "ok" || q.Source != "oauth" || q.Plan != "Google AI Pro" || len(q.Windows) != 1 {
		t.Fatalf("quota: %+v", q)
	}
	if w := q.Windows[0]; w.Name != "Gemini / Pro" || w.UsedPercent != 75 || w.ResetsAt != now.Add(3*time.Hour).Unix() {
		t.Fatalf("window: %+v", w)
	}
	if len(asked) != 2 || !strings.Contains(asked[0], `"pluginType":"GEMINI"`) || asked[1] != `/v1internal:retrieveUserQuotaSummary {"project":"proj-1"}` {
		t.Fatalf("asked: %q", asked)
	}
}

func TestAntigravityCloudQuotaTellsAnExpiredLoginFromARefusal(t *testing.T) {
	for code, want := range map[int]string{401: "auth_required", 403: "unavailable", 429: "throttled", 500: "unavailable"} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }))
		ctx := context.WithValue(context.Background(), quotaNoteKey{}, &quotaNote{})
		q := fetchAntigravityCloudQuota(ctx, server.Client(), server.URL+"/v1internal:", "tok", time.Now())
		server.Close()
		if q.Status != want || q.Source != "oauth" || len(q.Windows) != 0 {
			t.Errorf("HTTP %d: %+v", code, q)
		}
	}
	// A summary with no numbers in it is not an empty allowance.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer server.Close()
	if q := fetchAntigravityCloudQuota(context.Background(), server.Client(), server.URL+"/v1internal:", "tok", time.Now()); q.Status != "unavailable" {
		t.Fatalf("empty summary: %+v", q)
	}
}

func TestParseAntigravityStatuslineQuotaDistinguishesArgon(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw := []byte(`{
		"plan_tier": "Google AI Pro",
		"model": {"display_name": "Gemini 4 Argon (High)"},
		"quota": {
			"gemini-5h": {"remaining_fraction": 0.85, "reset_time": "2027-01-01T00:00:00Z"},
			"gemini-argon-wtu-weekly": {"remaining_fraction": 0.09, "reset_time": "2027-01-07T00:00:00Z"},
			"gemini-weekly": {"remaining_fraction": 0.95, "reset_time": "2027-01-07T00:00:00Z"},
			"3p-5h": {"remaining_fraction": 1.0, "reset_time": "2027-01-01T00:00:00Z"}
		}
	}`)
	q, err := ParseAntigravityStatuslineQuota(raw, now)
	if err != nil {
		t.Fatal(err)
	}
	if q.Status != "ok" || q.Source != "statusline" || q.Plan != "Google AI Pro" || len(q.Windows) != 4 {
		t.Fatalf("quota: %+v", q)
	}
	pools := map[string]float64{}
	for _, w := range q.Windows {
		pools[w.pool] = w.UsedPercent
	}
	if argon, ok := pools["gemini-argon"]; !ok || argon < 90.9 || argon > 91.1 {
		t.Errorf("argon pool: %+v", pools)
	}
	if gemini, ok := pools["gemini-models"]; !ok || gemini < 4.9 || gemini > 15.1 {
		t.Errorf("gemini-models pool: %+v", pools)
	}
	if p3, ok := pools["claude-and-gpt-models"]; !ok || p3 != 0 {
		t.Errorf("3p pool: %+v", pools)
	}
}

func TestReadAntigravityStatuslineQuota(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	t.Setenv("ANTIGRAVITY_CONFIG_DIR", dir)
	if q := readAntigravityStatuslineQuota(now); q.Status != "setup_required" {
		t.Fatalf("no statusline file: %+v", q)
	}
	quota := AgentQuota{
		Provider:   "antigravity",
		Source:     "statusline",
		Plan:       "Google AI Pro",
		Status:     "ok",
		ObservedAt: now.Unix(),
		Windows: []QuotaWindow{
			{Name: "Argon 7d", UsedPercent: 91, ResetsAt: now.Unix() + 3600},
		},
	}
	data, _ := json.Marshal(quota)
	if err := os.WriteFile(filepath.Join(dir, "pairfob-quota.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	q := readAntigravityStatuslineQuota(now)
	if q.Status != "ok" || len(q.Windows) != 1 || q.Windows[0].pool != "gemini-argon" {
		t.Fatalf("read statusline quota: %+v", q)
	}
}
