package runtime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestQuotaStatusesMapToBothWires(t *testing.T) {
	legacy := map[string]bool{"ok": true, "stale": true, "not_installed": true, "not_logged_in": true, "unsupported": true,
		"unavailable": true, "setup_required": true, "auth_required": true, "not_running": true}
	reasons := map[string][]string{
		"ok": {""}, "throttled": {""}, "failed": {"unavailable", "timeout"},
		"needs_action":   {"relogin", "allow_keychain", "choose_account", "setup"},
		"not_configured": {"not_installed", "no_login", "not_running", "unsupported_login"},
	}
	for status, want := range quotaStatuses {
		if !legacy[want.legacy] {
			t.Errorf("%s reports %q, which the first wire does not define", status, want.legacy)
		}
		allowed := false
		for _, reason := range reasons[want.state] {
			allowed = allowed || reason == want.reason
		}
		if !allowed {
			t.Errorf("%s: state %q does not carry reason %q", status, want.state, want.reason)
		}
		q := emptyQuota("grok", "oauth", status)
		if got := legacyQuota(q); got.Status != want.legacy || got.Windows == nil {
			t.Errorf("%s first wire: %+v", status, got)
		}
	}
	for status, want := range map[string][2]string{
		"keychain_denied": {"needs_action", "allow_keychain"}, "ambiguous": {"needs_action", "choose_account"},
		"not_running": {"not_configured", "not_running"}, "timeout": {"failed", "timeout"}, "never heard of it": {"failed", "unavailable"},
	} {
		a := quotaAccount(emptyQuota("cursor", "web_api", status))
		if a.State != want[0] || a.Reason != want[1] || a.ID != "cursor" || a.ObservedAt != 0 || len(a.Meters) != 0 || a.Meters == nil {
			t.Errorf("%s: %+v", status, a)
		}
	}
	if got := legacyQuota(emptyQuota("grok", "oauth", "never heard of it")); got.Status != "unavailable" {
		t.Errorf("unknown status reached the first wire: %+v", got)
	}
}

func TestQuotaAccountMarksWhatStandsForThePlan(t *testing.T) {
	now := time.Unix(1800000000, 0)
	meters := func(q AgentQuota) map[string]QuotaMeter {
		t.Helper()
		a := quotaAccount(q)
		if a.State != "ok" || a.ObservedAt != now.Unix() {
			t.Fatalf("%+v", a)
		}
		out := map[string]QuotaMeter{}
		for _, m := range a.Meters {
			if !validQuotaMeter(m) {
				t.Fatalf("invalid meter %+v", m)
			}
			out[m.Name] = m
		}
		return out
	}

	codex := meters(parseCodexQuota([]byte(`{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1800001000},"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1800100000}},"codex_Other Model":{"limitName":"Other Model","primary":{"usedPercent":90,"windowDurationMins":300,"resetsAt":1800001000}}}}`), "pro", now))
	if m := codex["codex"]; !m.Headline || m.Pool != "plan" || m.Kind != "quota" {
		t.Fatalf("codex plan bucket: %+v", m)
	}
	if m := codex["Other Model"]; m.Headline || m.Pool != "codex-other-model" || *m.UsedPercent != 90 {
		t.Fatalf("codex model bucket: %+v", m)
	}
	// With no bucket named for the plan, none can be set aside as secondary.
	only := meters(parseCodexQuota([]byte(`{"rateLimitsByLimitId":{"review":{"primary":{"usedPercent":5,"windowDurationMins":300,"resetsAt":1800001000}}}}`), "", now))
	if m := only["review"]; !m.Headline || m.Pool != "plan" {
		t.Fatalf("lone bucket: %+v", m)
	}

	auth := claudeQuotaAuth{}
	auth.OAuth.AccessToken = "test-credential"
	c := quotaFixtureClient(t, "api.anthropic.com", "/api/oauth/usage", "", 200, `{"five_hour":{"utilization":10,"resets_at":"2027-01-16T00:00:00Z"},"seven_day":{"utilization":20},"seven_day_opus":{"utilization":95},"seven_day_sonnet":{"utilization":1}}`)
	claude := meters(fetchClaudeQuota(context.Background(), c, auth, now))
	if !claude["five hour"].Headline || !claude["seven day"].Headline || claude["seven day opus"].Headline || claude["seven day opus"].Pool == claude["seven day sonnet"].Pool {
		t.Fatalf("claude: %+v", claude)
	}
	if m := claude["seven day"]; m.ResetsAt != 0 || m.WindowMinutes != 10080 {
		t.Fatalf("claude invented a reset: %+v", m)
	}

	copilot := meters(parseCopilotQuota([]byte(`{"quota_snapshots":{"premium_interactions":{"percent_remaining":73.5,"entitlement":300},"chat":{"unlimited":true}}}`), now))
	if m := copilot["premium interactions"]; !m.Headline || *m.UsedPercent != 26.5 {
		t.Fatalf("copilot premium: %+v", m)
	}
	if m := copilot["chat"]; m.Headline || m.Kind != "unlimited" || m.UsedPercent != nil {
		t.Fatalf("copilot chat: %+v", m)
	}
	raw, _ := json.Marshal(quotaAccount(parseCopilotQuota([]byte(`{"quota_snapshots":{"chat":{"unlimited":true}}}`), now)))
	if strings.Contains(string(raw), "used_percent") || !strings.Contains(string(raw), `"kind":"unlimited"`) {
		t.Fatalf("unlimited meter carries a share: %s", raw)
	}

	if m := meters(parseCursorQuota([]byte(`{"individualUsage":{"plan":{"totalPercentUsed":25}}}`), now))["Included plan"]; !m.Headline || m.Pool != "plan" {
		t.Fatalf("cursor: %+v", m)
	}
	if m := meters(parseGrokQuota([]byte(`{"config":{"creditUsagePercent":0}}`), now))["Shared subscription quota"]; !m.Headline || m.UsedPercent == nil || *m.UsedPercent != 0 {
		t.Fatalf("grok zero usage: %+v", m)
	}
	// A window whose reset has passed is still what was read; the phone greys that one row.
	stale := parseCodexQuota([]byte(`{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":1800000000}}}`), "plus", now)
	if a := quotaAccount(stale); stale.Status != "stale" || a.State != "ok" || len(a.Meters) != 1 || legacyQuota(stale).Status != "stale" {
		t.Fatalf("%+v", a)
	}
}

func TestQuotaMeterKindsCarryOnlyTheirOwnFields(t *testing.T) {
	share, count, limit := 40.0, int64(188), int64(500)
	zero := int64(0)
	valid := []QuotaMeter{
		{Kind: "quota", Name: "five_hour", Pool: "plan", Headline: true, UsedPercent: &share, WindowMinutes: 300, ResetsAt: 1800001000},
		{Kind: "quota", Name: "requests", Pool: "plan", UsedPercent: &share, Used: &count, Limit: &limit, Unit: "requests"},
		{Kind: "balance", Name: "top_up", Pool: "top-up", Amount: &count, Scale: 2, Unit: "usd"},
		{Kind: "balance", Name: "top_up", Pool: "top-up", Amount: &zero, Unit: "credits"},
		{Kind: "level", Name: "opus", Pool: "model", Level: "low"},
		{Kind: "unlimited", Name: "completions", Pool: "completions"},
		{Kind: "unread", Name: "top_up", Pool: "top-up"},
	}
	for _, m := range valid {
		if !validQuotaMeter(m) {
			t.Errorf("rejected %+v", m)
		}
	}
	over := 100.5
	invalid := []QuotaMeter{
		{Kind: "quota", Name: "five_hour", Pool: "plan"},
		{Kind: "quota", Name: "five_hour", Pool: "plan", UsedPercent: &over},
		{Kind: "quota", Name: "requests", Pool: "plan", UsedPercent: &share, Used: &count},
		{Kind: "quota", Name: "requests", Pool: "plan", UsedPercent: &share, Used: &count, Limit: &zero, Unit: "requests"},
		{Kind: "quota", Name: "requests", Pool: "plan", UsedPercent: &share, Used: &count, Limit: &limit, Unit: "tokens"},
		{Kind: "balance", Name: "top_up", Pool: "top-up", Unit: "usd"},
		{Kind: "balance", Name: "top_up", Pool: "top-up", Amount: &count, Unit: "usd", UsedPercent: &share},
		{Kind: "balance", Name: "top_up", Pool: "top-up", Amount: &count, Scale: 7, Unit: "usd"},
		{Kind: "level", Name: "opus", Pool: "model", Level: "plenty"},
		{Kind: "level", Name: "opus", Pool: "model", Level: "low", UsedPercent: &share},
		{Kind: "unlimited", Name: "chat", Pool: "chat", UsedPercent: &zeroShare},
		{Kind: "unread", Name: "top_up", Pool: "top-up", Headline: true},
		{Kind: "quota", Name: "", Pool: "plan", UsedPercent: &share},
		{Kind: "quota", Name: "five_hour", Pool: "Plan A", UsedPercent: &share},
		{Kind: "gauge", Name: "five_hour", Pool: "plan", UsedPercent: &share},
	}
	for _, m := range invalid {
		if validQuotaMeter(m) {
			t.Errorf("accepted %+v", m)
		}
	}
	for name, want := range map[string]string{"premium_interactions": "premium-interactions", "Gemini 3 Pro / High": "gemini-3-pro-high", "  ": "other", "模型": "other", strings.Repeat("a", 90): strings.Repeat("a", 64)} {
		if got := quotaPool(name); got != want || !quotaToken.MatchString(got) {
			t.Errorf("pool of %q = %q, want %q", name, got, want)
		}
	}
}

var zeroShare = 0.0

func TestQuotaFailedReadKeepsOnlyARecentSample(t *testing.T) {
	now := time.Unix(1800000000, 0)
	share := 28.0
	good := QuotaAccount{ID: "codex", Provider: "codex", Plan: "pro", State: "ok", ObservedAt: now.Unix() - 480,
		Meters: []QuotaMeter{{Kind: "quota", Name: "codex", Pool: "plan", Headline: true, UsedPercent: &share}}}
	failed := QuotaAccount{ID: "codex", Provider: "codex", State: "failed", Reason: "timeout", Meters: []QuotaMeter{}}

	got := CarryQuotaSample(failed, &good, now)
	if got.State != "failed" || got.Reason != "timeout" || got.ObservedAt != good.ObservedAt || len(got.Meters) != 1 || got.Plan != "pro" {
		t.Fatalf("recent sample dropped: %+v", got)
	}
	got.Meters[0].Name = "changed"
	if good.Meters[0].Name != "codex" {
		t.Fatal("carried sample aliases the kept one")
	}
	if got = CarryQuotaSample(failed, &good, now.Add(8*time.Minute)); len(got.Meters) != 0 || got.ObservedAt != 0 {
		t.Fatalf("sample past fifteen minutes shown: %+v", got)
	}
	if got = CarryQuotaSample(failed, nil, now); len(got.Meters) != 0 {
		t.Fatalf("%+v", got)
	}
	// A login that stopped reading may be another account's by now.
	for _, state := range []string{"needs_action", "not_configured", "ok"} {
		next := QuotaAccount{ID: "codex", Provider: "codex", State: state, Meters: []QuotaMeter{}}
		if got = CarryQuotaSample(next, &good, now); len(got.Meters) != 0 {
			t.Fatalf("%s kept old numbers: %+v", state, got)
		}
	}
	throttled := QuotaAccount{ID: "codex", Provider: "codex", State: "throttled", RetryAt: now.Unix() + 180, Meters: []QuotaMeter{}}
	if got = CarryQuotaSample(throttled, &good, now); len(got.Meters) != 1 || got.RetryAt != now.Unix()+180 {
		t.Fatalf("throttled read lost its sample: %+v", got)
	}
	if QuotaAccountSampled(failed) || QuotaAccountSampled(got) || !QuotaAccountSampled(good) {
		t.Fatal("only a read that worked is a sample to keep")
	}
}

func TestQuotaReadReportsRateLimitAndTimeout(t *testing.T) {
	header := http.Header{}
	respond := func(code int) *http.Client {
		return &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: code, Header: header, Body: io.NopCloser(strings.NewReader(`{}`)), Request: r}, nil
		})}
	}
	provider := func(client *http.Client) quotaProvider {
		return quotaProvider{name: "cursor", source: "web_api", locate: func(context.Context) (quotaRead, AgentQuota) {
			return func(ctx context.Context) AgentQuota { return fetchCursorQuota(ctx, client, "cookie", time.Now()) }, AgentQuota{}
		}}
	}
	for _, tc := range []struct {
		header   string
		min, max int64
	}{{"180", 175, 185}, {"1", 55, 65}, {"86400", 3590, 3605}, {"", 0, 0}, {"soon", 0, 0}} {
		header.Set("Retry-After", tc.header)
		r := provider(respond(429)).read(context.Background())
		wait := r.Account.RetryAt - time.Now().Unix()
		if r.Account.State != "throttled" || r.Legacy.Status != "unavailable" || (tc.max == 0 && r.Account.RetryAt != 0) || (tc.max != 0 && (wait < tc.min || wait > tc.max)) {
			t.Fatalf("Retry-After %q: %+v wait=%d", tc.header, r.Account, wait)
		}
	}
	if r := provider(respond(401)).read(context.Background()); r.Account.State != "needs_action" || r.Account.Reason != "relogin" || r.Account.RetryAt != 0 || r.Legacy.Status != "auth_required" {
		t.Fatalf("%+v", r.Account)
	}

	slow := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if r := provider(slow).read(ctx); r.Account.State != "failed" || r.Account.Reason != "timeout" || r.Legacy.Status != "unavailable" {
		t.Fatalf("slow read: %+v", r.Account)
	}

	// A read that would start a CLI waits for a slot, and gives up with the batch.
	for range cap(quotaSpawnSlots) {
		quotaSpawnSlots <- struct{}{}
	}
	defer func() {
		for range cap(quotaSpawnSlots) {
			<-quotaSpawnSlots
		}
	}()
	started := false
	spawning := quotaProvider{name: "codex", source: "app_server", spawns: true, locate: func(context.Context) (quotaRead, AgentQuota) {
		return func(context.Context) AgentQuota { started = true; return emptyQuota("codex", "app_server", "ok") }, AgentQuota{}
	}}
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if r := spawning.read(ctx); started || r.Account.Reason != "timeout" || r.Legacy.Source != "app_server" {
		t.Fatalf("spawned past the limit: %+v", r.Account)
	}
}

func TestClaudeForbiddenIsAFailedReadAndUnauthorizedALoginToRenew(t *testing.T) {
	auth := claudeQuotaAuth{}
	auth.OAuth.AccessToken = "test-credential"
	for code, want := range map[int][2]string{401: {"needs_action", "relogin"}, 403: {"failed", "unavailable"}} {
		client := quotaFixtureClient(t, "api.anthropic.com", "/api/oauth/usage", "Bearer test-credential", code, `{}`)
		provider := quotaProvider{name: "claude", source: "oauth", locate: func(context.Context) (quotaRead, AgentQuota) {
			return func(ctx context.Context) AgentQuota {
				return claudeForbiddenIsNotALogin(ctx, fetchClaudeQuota(ctx, client, auth, time.Now()))
			}, AgentQuota{}
		}}
		if r := provider.read(context.Background()); r.Account.State != want[0] || r.Account.Reason != want[1] || len(r.Account.Meters) != 0 {
			t.Fatalf("HTTP %d: %+v", code, r.Account)
		}
	}
	// Other providers keep both refusals as a login to renew.
	cursor := quotaProvider{name: "cursor", source: "web_api", locate: func(context.Context) (quotaRead, AgentQuota) {
		client := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 403, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`)), Request: r}, nil
		})}
		return func(ctx context.Context) AgentQuota { return fetchCursorQuota(ctx, client, "cookie", time.Now()) }, AgentQuota{}
	}}
	if r := cursor.read(context.Background()); r.Account.Reason != "relogin" {
		t.Fatalf("cursor 403: %+v", r.Account)
	}
}

func TestCopilotBorrowedLoginWithoutCopilotIsNotALogin(t *testing.T) {
	for status, want := range map[string]string{"auth_required": "not_logged_in", "unavailable": "not_logged_in", "timeout": "timeout", "throttled": "throttled", "ok": "ok"} {
		if got := borrowedCopilotQuota(emptyQuota("copilot", "github_api", status)); got.Status != want || got.Provider != "copilot" || got.Source != "github_api" {
			t.Errorf("%s: %+v", status, got)
		}
	}
}

func TestQuotaSourcesKeepTheFirstWireOrder(t *testing.T) {
	// The first six are the first operation's order; a V2-only provider follows.
	want := []string{"codex", "claude", "antigravity", "copilot", "cursor", "grok", "deepseek", "opencode-go", "command-code"}
	sources := QuotaSources()
	if len(sources) != len(want) {
		t.Fatalf("%d sources", len(sources))
	}
	for i, source := range sources {
		if source.ID != want[i] || source.Read == nil || !quotaToken.MatchString(source.ID) {
			t.Fatalf("source %d: %q", i, source.ID)
		}
	}
}
