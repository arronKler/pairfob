package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// Kiro stores its social login as one auth_kv row whose value is a JSON string.
func kiroSQLiteStub(t *testing.T, value string, err error) {
	t.Helper()
	restore := quotaSQLite
	t.Cleanup(func() { quotaSQLite = restore })
	quotaSQLite = func(_, query string) ([]byte, error) {
		if !strings.Contains(query, "auth_kv") || !strings.Contains(query, kiroAuthRow) {
			t.Errorf("unexpected query: %s", query)
		}
		if err != nil {
			return nil, err
		}
		return []byte(`[{"value":` + quoteJSON(value) + `}]`), nil
	}
}

func quoteJSON(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func TestKiroUsageBecomesCreditWindows(t *testing.T) {
	now := time.Unix(1800000000, 0)
	login := `{"access_token":"aoa-test-token-value","refresh_token":"aor-test","profile_arn":"arn:aws:codewhisperer:us-east-1:1:profile/X"}`
	kiroSQLiteStub(t, login, nil)
	body := `{"subscriptionInfo":{"subscriptionTitle":"KIRO FREE"},"usageBreakdownList":[
		{"resourceType":"CREDIT","displayName":"Credit","unit":"INVOCATIONS","usageLimitWithPrecision":50,"currentUsageWithPrecision":12.5,"nextDateReset":1800600000}]}`
	c := quotaFixtureClient(t, "codewhisperer.us-east-1.amazonaws.com", "/", "Bearer aoa-test-token-value", 200, body)
	a := fetchKiroQuota(context.Background(), c, "/tmp/kiro.sqlite3", now)
	if a.ID != "kiro" || a.Provider != "kiro" || a.Source != "local_api" || a.State != "ok" || a.Plan != "KIRO FREE" || len(a.Meters) != 1 {
		t.Fatalf("%+v", a)
	}
	m := a.Meters[0]
	if m.Kind != "quota" || m.Name != "Credit" || m.Pool != "credit" || !m.Headline || m.UsedPercent == nil || *m.UsedPercent != 25 || m.ResetsAt != 1800600000 {
		t.Fatalf("%+v", m)
	}
	// A fractional unit is not printed as a count; the share still stands.
	if m.Used != nil || m.Limit != nil || m.Unit != "" {
		t.Fatalf("%+v", m)
	}
}

func TestKiroCountsAreKeptWhenWhole(t *testing.T) {
	now := time.Unix(1800000000, 0)
	body := `{"subscriptionInfo":{"subscriptionTitle":"KIRO PRO"},"usageBreakdownList":[
		{"resourceType":"CREDIT","displayName":"Credit","unit":"CREDIT","usageLimitWithPrecision":1000,"currentUsageWithPrecision":250,"nextDateReset":1800600000},
		{"resourceType":"INVOCATION","displayName":"Requests","unit":"INVOCATIONS","usageLimitWithPrecision":100,"currentUsageWithPrecision":10,"nextDateReset":1800600000}]}`
	a := parseKiroQuota([]byte(body), now)
	if len(a.Meters) != 2 {
		t.Fatalf("%+v", a)
	}
	if *a.Meters[0].Used != 250 || *a.Meters[0].Limit != 1000 || a.Meters[0].Unit != "credits" || !a.Meters[0].Headline {
		t.Fatalf("%+v", a.Meters[0])
	}
	if *a.Meters[1].UsedPercent != 10 || a.Meters[1].Unit != "requests" || a.Meters[1].Headline || a.Meters[1].Pool == a.Meters[0].Pool {
		t.Fatalf("%+v", a.Meters[1])
	}
}

func TestKiroParsingFailsClosed(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, body := range []string{
		`{}`,
		`{"subscriptionInfo":{"subscriptionTitle":"X"},"usageBreakdownList":[]}`,
		`{"usageBreakdownList":[{"displayName":"Credit","usageLimitWithPrecision":0,"currentUsageWithPrecision":1}]}`,
		`{"usageBreakdownList":[{"displayName":"Credit","usageLimitWithPrecision":10,"currentUsageWithPrecision":-1}]}`,
	} {
		if a := parseKiroQuota([]byte(body), now); a.State != "failed" || a.Reason != "unavailable" || len(a.Meters) != 0 || a.ObservedAt != 0 {
			t.Fatalf("%s: %+v", body, a)
		}
	}
	// A used count above the cap is clamped rather than rejected: the provider
	// still answered, and the share is what the phone draws.
	over := `{"usageBreakdownList":[{"displayName":"Credit","usageLimitWithPrecision":10,"currentUsageWithPrecision":15}]}`
	if a := parseKiroQuota([]byte(over), now); a.State != "ok" || *a.Meters[0].UsedPercent != 100 {
		t.Fatalf("%+v", a)
	}
}

func TestKiroLoginProblemsAreStates(t *testing.T) {
	now := time.Unix(1800000000, 0)
	kiroSQLiteStub(t, `{"access_token":"","profile_arn":"arn"}`, nil)
	if a := fetchKiroQuota(context.Background(), quotaHTTPClient(), "/tmp/x.sqlite3", now); a.State != "not_configured" || a.Reason != "no_login" {
		t.Fatalf("%+v", a)
	}
	kiroSQLiteStub(t, "", errors.New("no sqlite3 reader"))
	if a := fetchKiroQuota(context.Background(), quotaHTTPClient(), "/tmp/x.sqlite3", now); a.State != "failed" {
		t.Fatalf("%+v", a)
	}
	login := `{"access_token":"aoa-test-token-value","profile_arn":"arn:aws:codewhisperer:us-east-1:1:profile/X"}`
	for code, want := range map[int]struct{ state, reason string }{
		401: {state: "needs_action", reason: "relogin"},
		403: {state: "not_configured", reason: "unsupported_login"},
		500: {state: "failed", reason: "unavailable"},
	} {
		kiroSQLiteStub(t, login, nil)
		c := quotaFixtureClient(t, "codewhisperer.us-east-1.amazonaws.com", "/", "Bearer aoa-test-token-value", code, `{}`)
		a := fetchKiroQuota(context.Background(), c, "/tmp/x.sqlite3", now)
		if a.State != want.state || a.Reason != want.reason {
			t.Fatalf("%d: %+v", code, a)
		}
	}
}

func TestKiroMissingDatabaseIsNotInstalled(t *testing.T) {
	t.Setenv("KIRO_DATA_DIR", t.TempDir())
	if _, status := kiroDatabasePath(); status != "not_installed" {
		t.Fatalf("status %q", status)
	}
}
