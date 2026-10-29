package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDeepSeekBalanceBecomesAnAmountMeter(t *testing.T) {
	now := time.Unix(1800000000, 0)
	body := `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"211.39","granted_balance":"0.00","topped_up_balance":"211.39"}]}`
	c := quotaFixtureClient(t, "api.deepseek.com", "/user/balance", "Bearer sk-test-key", 200, body)
	a := fetchDeepSeekQuota(context.Background(), c, "sk-test-key", now)
	if a.ID != "deepseek" || a.Provider != "deepseek" || a.Source != "api" || a.State != "ok" || a.ObservedAt != now.Unix() || len(a.Meters) != 1 {
		t.Fatalf("%+v", a)
	}
	m := a.Meters[0]
	if m.Kind != "balance" || m.Name != "balance" || m.Pool != "cny" || !m.Headline || m.Amount == nil || *m.Amount != 21139 || m.Scale != 2 || m.Unit != "cny" || !validQuotaMeter(m) {
		t.Fatalf("%+v", m)
	}
	// A balance is not a share and never gains a percentage or reset.
	if m.UsedPercent != nil || m.Used != nil || m.Limit != nil || m.WindowMinutes != 0 || m.ResetsAt != 0 {
		t.Fatalf("%+v", m)
	}
}

func TestDeepSeekBalanceParsingFailsClosed(t *testing.T) {
	now := time.Unix(1800000000, 0)
	ok := `{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"12.40"}]}`
	if a := parseDeepSeekQuota([]byte(ok), now); a.State != "ok" || len(a.Meters) != 1 || *a.Meters[0].Amount != 1240 || a.Meters[0].Unit != "usd" {
		t.Fatalf("%+v", a)
	}
	// A zero balance is a real answer.
	zero := `{"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"0.00"}]}`
	if a := parseDeepSeekQuota([]byte(zero), now); a.State != "ok" || *a.Meters[0].Amount != 0 || a.Meters[0].Scale != 2 {
		t.Fatalf("%+v", a)
	}
	// Two currencies: the first stands for the account, the second stays visible.
	two := `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"1.00"},{"currency":"USD","total_balance":"2.00"}]}`
	if a := parseDeepSeekQuota([]byte(two), now); len(a.Meters) != 2 || !a.Meters[0].Headline || a.Meters[1].Headline || a.Meters[1].Pool != "usd" {
		t.Fatalf("%+v", a)
	}
	for _, body := range []string{
		`{}`, `{"is_available":true}`, `{"is_available":true,"balance_infos":[]}`,
		`{"is_available":true,"balance_infos":[{"currency":"EUR","total_balance":"1.00"}]}`,
		`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"1.234"}]}`,
		`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"-1.00"}]}`,
		`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"1,000.00"}]}`,
		`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":1}]}`,
	} {
		if a := parseDeepSeekQuota([]byte(body), now); a.State != "failed" || a.Reason != "unavailable" || len(a.Meters) != 0 || a.ObservedAt != 0 {
			t.Fatalf("%s: %+v", body, a)
		}
	}
}

func TestDeepSeekAmountReadsOnlyTwoDecimalPlaces(t *testing.T) {
	for raw, want := range map[string]int64{"0": 0, "0.00": 0, "12": 1200, "12.3": 1230, "12.34": 1234, "9999999999999.99": 999999999999999} {
		if got, ok := deepSeekAmount(raw); !ok || got != want {
			t.Errorf("%s = %d, %v; want %d", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", ".5", "1.", "1.234", "-1", "+1", "1 000", "abc", "99999999999999.99"} {
		if got, ok := deepSeekAmount(raw); ok {
			t.Errorf("accepted %q as %d", raw, got)
		}
	}
	if got := deepSeekUnit(" cny "); got != "cny" {
		t.Errorf("cny = %q", got)
	}
	if got := deepSeekUnit("EUR"); got != "" {
		t.Errorf("EUR = %q", got)
	}
}

func TestDeepSeekKeyComesFromTheEnvironmentOrTheStateDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PAIRFOB_STATE_DIR", dir)
	t.Setenv("DEEPSEEK_API_KEY", "sk-from-env")
	if key, status := deepSeekQuotaKey(); key != "sk-from-env" || status != "" {
		t.Fatalf("env: %q %q", key, status)
	}
	t.Setenv("DEEPSEEK_API_KEY", "")
	if key, status := deepSeekQuotaKey(); key != "" || status != "not_logged_in" {
		t.Fatalf("missing file: %q %q", key, status)
	}
	if err := os.WriteFile(filepath.Join(dir, "deepseek.key"), []byte("sk-from-file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if key, status := deepSeekQuotaKey(); key != "sk-from-file" || status != "" {
		t.Fatalf("file: %q %q", key, status)
	}
	if err := os.WriteFile(filepath.Join(dir, "deepseek.key"), []byte("export DEEPSEEK_API_KEY=sk-nope\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if key, status := deepSeekQuotaKey(); key != "" || status != "not_logged_in" {
		t.Fatalf("unusable file: %q %q", key, status)
	}
}

func TestDeepSeekHTTPRefusalsKeepTheirCause(t *testing.T) {
	now := time.Unix(1800000000, 0)
	c := quotaFixtureClient(t, "api.deepseek.com", "/user/balance", "Bearer sk-test-key", 401, `{}`)
	if a := fetchDeepSeekQuota(context.Background(), c, "sk-test-key", now); a.State != "needs_action" || a.Reason != "relogin" {
		t.Fatalf("401: %+v", a)
	}
	c = quotaFixtureClient(t, "api.deepseek.com", "/user/balance", "Bearer sk-test-key", 429, `{}`)
	if a := fetchDeepSeekQuota(context.Background(), c, "sk-test-key", now); a.State != "throttled" || len(a.Meters) != 0 {
		t.Fatalf("429: %+v", a)
	}
	c = quotaFixtureClient(t, "api.deepseek.com", "/user/balance", "Bearer sk-test-key", 500, `{}`)
	if a := fetchDeepSeekQuota(context.Background(), c, "sk-test-key", now); a.State != "failed" || a.Reason != "unavailable" {
		t.Fatalf("500: %+v", a)
	}
}

func TestDeepSeekIsOnlyOnAgentQuotaV2(t *testing.T) {
	t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
	t.Setenv("DEEPSEEK_API_KEY", "")
	if len(quotaProviders) != 6 {
		t.Fatalf("the first operation's providers changed: %d", len(quotaProviders))
	}
	var found bool
	for _, p := range quotaAccountProviders {
		if p.name != "deepseek" {
			continue
		}
		found = true
		reading := p.read(context.Background())
		if reading.Legacy != nil {
			t.Fatal("a V2-only provider reached the first wire")
		}
		if reading.Account.State != "not_configured" || reading.Account.Reason != "no_login" || reading.Account.Meters == nil {
			t.Fatalf("%+v", reading.Account)
		}
	}
	if !found {
		t.Fatal("deepseek is not a quota account provider")
	}
	var ids []string
	for _, source := range QuotaSources() {
		ids = append(ids, source.ID)
	}
	if len(ids) != 9 || ids[6] != "deepseek" || ids[7] != "opencode-go" || ids[8] != "command-code" {
		t.Fatalf("sources: %v", ids)
	}
}
