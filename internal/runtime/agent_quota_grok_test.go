package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGrokQuotaSharedCredits(t *testing.T) {
	now := time.Unix(1800000000, 0)
	q := parseGrokQuota([]byte(`{"config":{"creditUsagePercent":31,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2027-01-20T00:00:00Z"},"billingPeriodEnd":"2027-01-19T00:00:00Z"}}`), now)
	if q.Status != "ok" || len(q.Windows) != 1 || q.Windows[0].UsedPercent != 31 || q.Windows[0].WindowMinutes != 10080 || q.Windows[0].ResetsAt != quotaReset("2027-01-20T00:00:00Z") {
		t.Fatalf("%+v", q)
	}
	for _, body := range []string{`{}`, `{"config":{"onDemandUsed":{"val":3},"onDemandCap":{"val":10}}}`, `{"config":{"creditUsagePercent":null}}`, `{"config":{"creditUsagePercent":101}}`, `{"config":{"creditUsagePercent":-1}}`} {
		if q := parseGrokQuota([]byte(body), now); q.Status != "unavailable" || len(q.Windows) != 0 {
			t.Fatalf("invented allowance: %+v", q)
		}
	}
	for _, end := range []string{"", "malformed"} {
		raw, _ := json.Marshal(map[string]any{"config": map[string]any{"creditUsagePercent": 31, "currentPeriod": map[string]string{"end": end}, "billingPeriodEnd": "2027-01-20T00:00:00Z"}})
		q := parseGrokQuota(raw, now)
		if q.Status != "ok" || q.Windows[0].ResetsAt != 0 {
			t.Fatalf("invalid current period borrowed fallback: %+v", q)
		}
	}

	q = parseGrokQuota([]byte(`{"config":{"creditUsagePercent":0}}`), now)
	if q.Status != "ok" || q.Windows[0].ResetsAt != 0 {
		t.Fatalf("zero: %+v", q)
	}
	q = parseGrokQuota([]byte(`{"config":{"creditUsagePercent":31,"billingPeriodEnd":"2020-01-01T00:00:00Z"}}`), now)
	if q.Status != "stale" {
		t.Fatal(q.Status)
	}
}
func TestGrokQuotaCredentials(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GROK_HOME", dir)
	now := time.Unix(1800000000, 0)
	for _, tc := range []struct{ body, status string }{
		{`{"https://auth.x.ai::a":{"key":"fixture","expires_at":"2027-01-20T00:00:00Z","principal_type":"User"}}`, ""},
		{`{"https://auth.x.ai::a":{"key":"fixture","expires_at":"2020-01-20T00:00:00Z"}}`, "auth_required"},
		{`{"https://auth.x.ai::a":{"key":"fixture"}}`, "auth_required"},
		{`{"https://auth.x.ai::a":{"key":"fixture","expires_at":"2027-01-20T00:00:00Z","principal_type":"Team"}}`, "unsupported"},
		{`{"https://auth.x.ai::a":{"key":"fixture","expires_at":"2027-01-20T00:00:00Z"},"https://auth.x.ai::b":{}}`, "auth_required"},
		{`{"https://auth.x.ai::a":{"key":"fixture","expires_at":"2027-01-20T00:00:00Z"}}`, "unsupported"},

		{`{"https://untrusted.example":{"key":"fixture","expires_at":"2027-01-20T00:00:00Z"}}`, "auth_required"},
	} {
		if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(tc.body), 0600); err != nil {
			t.Fatal(err)
		}
		token, status := grokQuotaToken(now)
		if status != tc.status || (status != "" && token != "") {
			t.Fatalf("status %q expected %q", status, tc.status)
		}
	}
}
func TestGrokQuotaSettingsFailureDoesNotDiscardUsage(t *testing.T) {
	client := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "cli-chat-proxy.grok.com" || r.Header.Get("Authorization") != "Bearer fixture" || r.Header.Get("x-xai-token-auth") != "xai-grok-cli" {
			t.Error("incorrect destination or auth")
		}
		body, code := `{"config":{"creditUsagePercent":31}}`, 200
		switch r.URL.Path {
		case "/v1/settings":
			body, code = `{}`, 503
		case "/v1/billing":
			if r.URL.RawQuery != "format=credits" {
				t.Error("incorrect format")
			}
		default:
			t.Error("unexpected request")
		}
		return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	q := fetchGrokQuota(context.Background(), client, "fixture", time.Now())
	if q.Status != "ok" || q.Plan != "" {
		t.Fatalf("%+v", q)
	}
	raw, _ := json.Marshal(q)
	if strings.Contains(string(raw), "fixture") {
		t.Fatal("token in response")
	}
}
func TestGrokQuotaLive(t *testing.T) {
	if os.Getenv("PAIRFOB_TEST_LIVE_QUOTA") != "1" {
		t.Skip("opt-in local account read")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	q := readGrokQuota(ctx)
	raw, _ := json.Marshal(q)
	t.Log(string(raw))
	if q.Status != "ok" {
		t.Fatalf("live query: %s", q.Status)
	}
}
