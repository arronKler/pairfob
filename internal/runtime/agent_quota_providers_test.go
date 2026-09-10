package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type quotaRoundTrip func(*http.Request) (*http.Response, error)

func (f quotaRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func quotaFixtureClient(t *testing.T, host, path, auth string, code int, body string) *http.Client {
	t.Helper()
	return &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != host || r.URL.Path != path {
			t.Errorf("wrong quota destination: %s", r.URL)
		}
		if auth != "" && r.Header.Get("Authorization") != auth {
			t.Error("missing scoped authorization")
		}
		return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
}

func TestClaudeQuotaAutomaticOAuthRead(t *testing.T) {
	now := time.Unix(1800000000, 0)
	auth := claudeQuotaAuth{}
	auth.OAuth.AccessToken = "test-credential"
	auth.OAuth.Subscription = "max"
	body := `{"five_hour":{"utilization":25,"resets_at":"2027-01-16T09:00:00Z"},"seven_day_sonnet":{"utilization":0,"resets_at":null},"seven_day":null}`
	c := quotaFixtureClient(t, "api.anthropic.com", "/api/oauth/usage", "Bearer test-credential", 200, body)
	q := fetchClaudeQuota(context.Background(), c, auth, now)
	if q.Status != "ok" || q.Source != "oauth" || q.Plan != "max" || len(q.Windows) != 2 || q.Windows[1].UsedPercent != 0 || q.Windows[1].ResetsAt != 0 {
		t.Fatalf("%+v", q)
	}
	raw, _ := json.Marshal(q)
	if strings.Contains(string(raw), "test-credential") {
		t.Fatal("credential leaked")
	}
	c = quotaFixtureClient(t, "api.anthropic.com", "/api/oauth/usage", "Bearer test-credential", 403, `{"secret":"never surface"}`)
	q = fetchClaudeQuota(context.Background(), c, auth, now)
	if q.Status != "auth_required" || len(q.Windows) != 0 {
		t.Fatalf("%+v", q)
	}
}
func TestClaudeQuotaCredentialsRequireProfileScopeAndFreshLogin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	for _, auth := range []string{
		`{"claudeAiOauth":{"accessToken":"t"}}`,
		`{"claudeAiOauth":{"accessToken":"t","scopes":["user:inference"]}}`,
		`{"claudeAiOauth":{"accessToken":"t","expiresAt":1,"scopes":["user:profile"]}}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(auth), 0600); err != nil {
			t.Fatal(err)
		}
		if _, status := claudeQuotaCredentials(context.Background()); status != "auth_required" {
			t.Fatalf("%s", status)
		}
	}
	raw := `{"claudeAiOauth":{"accessToken":"t","scopes":["user:profile"]}}`
	_ = os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(raw), 0600)
	if _, status := claudeQuotaCredentials(context.Background()); status != "" {
		t.Fatalf("%s", status)
	}
}
func TestCopilotQuotaMissingAndUnlimitedAreDistinct(t *testing.T) {
	now := time.Unix(1800000000, 0)
	q := parseCopilotQuota([]byte(`{"copilot_plan":"individual_pro","quota_snapshots":{"premium_interactions":{"percent_remaining":73.5,"entitlement":300},"chat":{"unlimited":true}}}`), now)
	if q.Status != "ok" || len(q.Windows) != 2 || q.Windows[0].UsedPercent != 26.5 || q.Windows[0].ResetsAt != 0 || !q.Windows[1].Unlimited {
		t.Fatalf("%+v", q)
	}
	for _, body := range []string{`{}`, `{"quota_snapshots":{"premium_interactions":{"percent_remaining":100,"entitlement":0}}}`, `{"quota_snapshots":{"premium_interactions":{"entitlement":100}}}`} {
		q = parseCopilotQuota([]byte(body), now)
		if q.Status != "unavailable" || len(q.Windows) != 0 {
			t.Fatalf("placeholder: %+v", q)
		}
	}
	c := quotaFixtureClient(t, "api.github.com", "/copilot_internal/user", "token test-credential", 200, `{"quota_snapshots":{"chat":{"unlimited":true}}}`)
	if q = fetchCopilotQuota(context.Background(), c, "test-credential", now); q.Status != "ok" {
		t.Fatalf("%+v", q)
	}
}
func TestAntigravityQuotaRequiresActualRemainingFraction(t *testing.T) {
	now := time.Unix(1800000000, 0)
	body := `{"response":{"groups":[{"displayName":"Claude and GPT models","buckets":[{"bucketId":"weekly","remainingFraction":0.4},{"bucketId":"five_hour","remaining":{"case":"remainingFraction","value":0}},{"bucketId":"unknown"}]}]}}`
	q := parseAntigravityQuota([]byte(body), now)
	if q.Status != "ok" || len(q.Windows) != 2 || q.Windows[0].UsedPercent != 60 || q.Windows[1].UsedPercent != 100 {
		t.Fatalf("%+v", q)
	}
	legacy := `{"userStatus":{"userTier":{"name":"Ultra"},"cascadeModelConfigData":{"clientModelConfigs":[{"label":"Claude","quotaInfo":{"remainingFraction":0.75}},{"label":"Available only"}]}}}`
	q = parseAntigravityQuota([]byte(legacy), now)
	if q.Status != "ok" || q.Plan != "Ultra" || len(q.Windows) != 1 || q.Windows[0].UsedPercent != 25 {
		t.Fatalf("%+v", q)
	}
	for _, body := range []string{`{"clientModelConfigs":[{"label":"Available only"}]}`, `{"groups":[{"buckets":[{"bucketId":"missing"}]}]}`, `{"code":7,"groups":[{"buckets":[{"bucketId":"weekly","remainingFraction":1}]}]}`} {
		q = parseAntigravityQuota([]byte(body), now)
		if q.Status != "unavailable" {
			t.Fatalf("fake full quota: %+v", q)
		}
	}
	if yes, _ := antigravityExecutable("/usr/bin/python"); yes {
		t.Fatal("unrelated executable accepted")
	}
	if yes, cli := antigravityExecutable("/Users/u/.local/bin/agy"); !yes || !cli {
		t.Fatal("agy not detected")
	}
}
func TestQuotaHTTPDoesNotForwardCredentialsOnRedirect(t *testing.T) {
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; _, _ = w.Write([]byte(`{}`)) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	var value any
	status := quotaJSON(context.Background(), quotaHTTPClient(), source.URL, map[string]string{"Authorization": "Bearer secret"}, nil, &value)
	if status != "unavailable" || called {
		t.Fatal("followed credential-bearing redirect")
	}
}

func TestCopilotQuotaRejectsAmbiguousCredentialFiles(t *testing.T) {
	t.Setenv("COPILOT_GITHUB_TOKEN", "")
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if err := os.MkdirAll(filepath.Join(dir, "github-copilot"), 0700); err != nil {
		t.Fatal(err)
	}
	for i, file := range []string{"hosts.json", "apps.json"} {
		raw := []byte(`{"github.com":{"oauth_token":"account-` + string(rune('a'+i)) + `"}}`)
		if err := os.WriteFile(filepath.Join(dir, "github-copilot", file), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if got := copilotQuotaToken(context.Background()); got != "" {
		t.Fatal("ambiguous accounts selected")
	}
}
