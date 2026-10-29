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

const commandCodeWhoamiBody = `{"success":true,"user":{"id":"user_1","userName":"arron"},"org":{"id":"org abc","login":"acme"}}`
const commandCodeCreditsBody = `{"credits":{"monthlyCredits":50.93,"purchasedCredits":0,"freeCredits":2.5},
  "windowLimits":{"fiveHour":{"used":0.98,"cap":14,"resetAt":1790262790822},
                  "weekly":{"used":19.06,"cap":35,"resetAt":1790429616789}}}`
const commandCodeSubscriptionBody = `{"success":true,"data":{"planId":"individual-goat","status":"active",
  "currentPeriodStart":"2027-01-19T12:53:45.000Z","currentPeriodEnd":"2027-02-19T12:53:45.000Z"}}`

// commandCodeClient answers the three alpha reads by path and checks that each
// one carries the key and a product User-Agent.
func commandCodeClient(t *testing.T, whoami, credits, subscriptions int, bodies map[string]string) *http.Client {
	t.Helper()
	codes := map[string]int{"/alpha/whoami": whoami, "/alpha/billing/credits": credits, "/alpha/billing/subscriptions": subscriptions}
	return &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "api.commandcode.ai" {
			t.Errorf("wrong quota destination: %s", r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer user_test-key" || r.Header.Get("User-Agent") == "" || strings.HasPrefix(r.Header.Get("User-Agent"), "Go-http-client") {
			t.Errorf("%s: missing key or product User-Agent", r.URL.Path)
		}
		code, ok := codes[r.URL.Path]
		if !ok {
			t.Errorf("unexpected path %s", r.URL.Path)
			code = 404
		}
		if r.URL.Path != "/alpha/whoami" && r.URL.Query().Get("orgId") != "org abc" {
			t.Errorf("%s: billing read is not scoped to the org", r.URL.Path)
		}
		body := bodies[r.URL.Path]
		return &http.Response{StatusCode: code, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
}

func commandCodeFixture(t *testing.T) *http.Client {
	t.Helper()
	return commandCodeClient(t, 200, 200, 200, map[string]string{
		"/alpha/whoami": commandCodeWhoamiBody, "/alpha/billing/credits": commandCodeCreditsBody,
		"/alpha/billing/subscriptions": commandCodeSubscriptionBody,
	})
}

func TestCommandCodeWindowsAndBalance(t *testing.T) {
	now := time.Unix(1800000000, 0)
	a := fetchCommandCodeQuota(context.Background(), commandCodeFixture(t), "user_test-key", now)
	if a.ID != "command-code" || a.Provider != "command-code" || a.Plan != "Individual Goat" || a.Source != "api" ||
		a.State != "ok" || a.ObservedAt != now.Unix() || len(a.Meters) != 3 {
		t.Fatalf("%+v", a)
	}
	type want struct {
		name    string
		minutes int64
		percent float64
		used    int64
		limit   int64
		reset   int64
	}
	for i, w := range []want{
		{"five hour", 300, 7, 98, 1400, 1790262790},
		{"seven day", 10080, 54.5, 1906, 3500, 1790429616},
	} {
		m := a.Meters[i]
		if m.Kind != "quota" || m.Name != w.name || m.Pool != "plan" || !m.Headline || m.WindowMinutes != w.minutes ||
			m.UsedPercent == nil || *m.UsedPercent != w.percent || m.Used == nil || *m.Used != w.used || m.Limit == nil || *m.Limit != w.limit ||
			m.Scale != 2 || m.Unit != "usd" || m.ResetsAt != w.reset || !validQuotaMeter(m) {
			t.Fatalf("meter %d: %+v", i, m)
		}
	}
	balance := a.Meters[2]
	// The three credit pools are one balance, in dollars, reset by the billing period.
	if balance.Kind != "balance" || balance.Name != "monthly balance" || balance.Pool != "usd" || !balance.Headline ||
		balance.Amount == nil || *balance.Amount != 5343 || balance.Scale != 2 || balance.Unit != "usd" ||
		balance.ResetsAt != time.Date(2027, 2, 19, 12, 53, 45, 0, time.UTC).Unix() || !validQuotaMeter(balance) {
		t.Fatalf("balance: %+v", balance)
	}
}

func TestCommandCodeReadsStringAmountsAndEpochSeconds(t *testing.T) {
	now := time.Unix(1800000000, 0)
	credits := `{"credits":{"monthlyCredits":"$1,234.50","purchasedCredits":"2.25"},
	  "windowLimits":{"fiveHour":{"used":"$1.50","cap":"20.00","resetAt":"1800005000"}}}`
	a := parseCommandCodeQuota(parseCreditsFixture(t, credits), "", 0, now)
	if a.State != "ok" || len(a.Meters) != 2 {
		t.Fatalf("%+v", a)
	}
	if m := a.Meters[0]; *m.UsedPercent != 7.5 || *m.Used != 150 || *m.Limit != 2000 || m.ResetsAt != 1800005000 {
		t.Fatalf("%+v", m)
	}
	if m := a.Meters[1]; *m.Amount != 123675 {
		t.Fatalf("%+v", m)
	}
}

func TestCommandCodeWindowWithoutACapIsSkipped(t *testing.T) {
	now := time.Unix(1800000000, 0)
	credits := `{"credits":{"monthlyCredits":5},"windowLimits":{"fiveHour":{"used":0,"cap":0}}}`
	a := parseCommandCodeQuota(parseCreditsFixture(t, credits), "", 0, now)
	if a.State != "ok" || len(a.Meters) != 1 || a.Meters[0].Kind != "balance" {
		t.Fatalf("%+v", a)
	}
}

func TestCommandCodeParsingFailsClosed(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, body := range []string{
		``, `{}`, `{"credits":null}`,
		`{"credits":{"purchasedCredits":1}}`,
		`{"credits":{"monthlyCredits":-1}}`,
		`{"credits":{"monthlyCredits":5},"windowLimits":{"fiveHour":{"used":1}}}`,
		`{"credits":{"monthlyCredits":5},"windowLimits":{"fiveHour":{"used":-1,"cap":10}}}`,
		`{"credits":{"monthlyCredits":5},"windowLimits":{"weekly":{"used":1,"cap":"x"}}}`,
	} {
		var credits commandCodeCredits
		if json.Unmarshal([]byte(body), &credits) != nil {
			continue // a body that does not decode is refused before parsing
		}
		a := parseCommandCodeQuota(credits, "", 0, now)
		if a.State != "failed" || a.Reason != "unavailable" || len(a.Meters) != 0 || a.ObservedAt != 0 {
			t.Fatalf("%s: %+v", body, a)
		}
	}
}

func TestCommandCodeMalformedCreditsBodyIsUnavailable(t *testing.T) {
	now := time.Unix(1800000000, 0)
	c := commandCodeClient(t, 200, 200, 200, map[string]string{
		"/alpha/whoami":                commandCodeWhoamiBody,
		"/alpha/billing/credits":       `{"credits":{"monthlyCredits":"nope"}}`,
		"/alpha/billing/subscriptions": commandCodeSubscriptionBody,
	})
	if a := fetchCommandCodeQuota(context.Background(), c, "user_test-key", now); a.State != "failed" || a.Reason != "unavailable" || len(a.Meters) != 0 {
		t.Fatalf("%+v", a)
	}
}

// parseCreditsFixture decodes a credits body the way the read does, keeping
// the zero value on a body that does not decode at all.
func parseCreditsFixture(t *testing.T, body string) commandCodeCredits {
	t.Helper()
	var c commandCodeCredits
	_ = json.Unmarshal([]byte(body), &c)
	return c
}

func TestCommandCodeLosingThePlanKeepsTheNumbers(t *testing.T) {
	now := time.Unix(1800000000, 0)
	c := commandCodeClient(t, 200, 200, 500, map[string]string{
		"/alpha/whoami": commandCodeWhoamiBody, "/alpha/billing/credits": commandCodeCreditsBody,
	})
	a := fetchCommandCodeQuota(context.Background(), c, "user_test-key", now)
	if a.State != "ok" || a.Plan != "" || len(a.Meters) != 3 || a.Meters[2].ResetsAt != 0 {
		t.Fatalf("%+v", a)
	}
}

func TestCommandCodeRefusalsKeepTheirCause(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, tc := range []struct {
		whoami, credits, subscriptions int
		state, reason                  string
	}{
		{401, 200, 200, "needs_action", "relogin"},
		{403, 200, 200, "needs_action", "relogin"},
		{200, 401, 200, "needs_action", "relogin"},
		{200, 429, 200, "throttled", ""},
		{200, 500, 200, "failed", "unavailable"},
		{200, 200, 403, "needs_action", "relogin"},
	} {
		bodies := map[string]string{"/alpha/whoami": commandCodeWhoamiBody, "/alpha/billing/credits": commandCodeCreditsBody,
			"/alpha/billing/subscriptions": commandCodeSubscriptionBody}
		if tc.whoami != 200 {
			bodies["/alpha/whoami"] = `{}`
		}
		a := fetchCommandCodeQuota(context.Background(), commandCodeClient(t, tc.whoami, tc.credits, tc.subscriptions, bodies), "user_test-key", now)
		if a.State != tc.state || a.Reason != tc.reason || len(a.Meters) != 0 {
			t.Fatalf("%d/%d/%d: %+v", tc.whoami, tc.credits, tc.subscriptions, a)
		}
	}
}

func TestCommandCodeKeyPrefersTheVendorVariableThenTheCLIThenTheFile(t *testing.T) {
	home := t.TempDir()
	dir := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	t.Setenv("COMMAND_CODE_API_KEY", "user_from-vendor")
	t.Setenv("COMMANDCODE_API_KEY", "user_from-alias")
	key := commandCodeKey
	if got, status := key(); got != "user_from-vendor" || status != "" {
		t.Fatalf("vendor env: %q %q", got, status)
	}
	t.Setenv("COMMAND_CODE_API_KEY", "")
	if got, status := key(); got != "user_from-alias" || status != "" {
		t.Fatalf("alias env: %q %q", got, status)
	}
	t.Setenv("COMMANDCODE_API_KEY", "")
	if got, status := key(); got != "" || status != "not_logged_in" {
		t.Fatalf("no login: %q %q", got, status)
	}
	if err := os.WriteFile(filepath.Join(dir, "command-code.key"), []byte("user_from-file"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, status := key(); got != "user_from-file" || status != "" {
		t.Fatalf("file: %q %q", got, status)
	}
	// The CLI's own login is in ~/.commandcode/auth.json under apiKey.
	if err := os.MkdirAll(filepath.Join(home, ".commandcode"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".commandcode", "auth.json"),
		[]byte(`{"apiKey":"user_from-cli","userName":"arron","keyName":"mac"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got, status := key(); got != "user_from-cli" || status != "" {
		t.Fatalf("CLI login: %q %q", got, status)
	}
	// A stored line that is not a key is not a login.
	if err := os.WriteFile(filepath.Join(home, ".commandcode", "auth.json"),
		[]byte(`{"apiKey":"user from file"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got, status := key(); got != "user_from-file" || status != "" {
		t.Fatalf("unusable CLI login: %q %q", got, status)
	}
}

func TestCommandCodePlanNamesAndTimes(t *testing.T) {
	for raw, want := range map[string]string{
		"individual-goat": "Individual Goat", "pro_plan": "Pro Plan", " Team.X ": "Team X",
	} {
		if got := commandCodePlan(raw); got != want {
			t.Errorf("%q = %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{"", "a<b", strings.Repeat("x", 65), "pl an"} {
		if got := commandCodePlan(raw); got != "" {
			t.Errorf("%q = %q, want none", raw, got)
		}
	}
	for raw, want := range map[string]int64{
		`1790262790`:             1790262790,
		`1790262790822`:          1790262790,
		`"1790262790"`:           1790262790,
		`"2027-02-19T12:53:45Z"`: time.Date(2027, 2, 19, 12, 53, 45, 0, time.UTC).Unix(),
		`"soon"`:                 0,
		`"0"`:                    0,
		`-5`:                     0,
		`99999999999999`:         0,
	} {
		var t0 quotaFlexTime
		if err := json.Unmarshal([]byte(raw), &t0); err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if got := t0.unix(); got != want {
			t.Errorf("%s = %d, want %d", raw, got, want)
		}
	}
}
