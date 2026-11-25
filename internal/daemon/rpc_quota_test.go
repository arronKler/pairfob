package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func quotaTestReading(id, state, reason string, used float64) runtime.QuotaReading {
	account := runtime.QuotaAccount{ID: id, Provider: id, State: state, Reason: reason, Meters: []runtime.QuotaMeter{}}
	legacy := runtime.AgentQuota{Provider: id, Source: "app_server", Status: "unavailable", Windows: []runtime.QuotaWindow{}}
	if state == "ok" {
		account.Plan, account.ObservedAt = "pro", time.Now().Unix()
		account.Meters = []runtime.QuotaMeter{{Kind: "quota", Name: id, Pool: "plan", Headline: true, UsedPercent: &used, WindowMinutes: 300, ResetsAt: 2100000000}}
		legacy.Plan, legacy.Status, legacy.ObservedAt = "pro", "ok", account.ObservedAt
		legacy.Windows = []runtime.QuotaWindow{{Name: id, UsedPercent: used, WindowMinutes: 300, ResetsAt: 2100000000}}
	}
	return runtime.QuotaReading{Account: account, Legacy: &legacy}
}

// quotaTestAge makes an account's cached reading look read that long ago.
func quotaTestAge(e *Engine, id string, age time.Duration) {
	e.quotas.mu.Lock()
	defer e.quotas.mu.Unlock()
	e.quotas.entries[id].sampled = time.Now().Add(-age)
}

func quotaTestItems(t *testing.T, raw []byte) []runtime.QuotaAccount {
	t.Helper()
	var result struct {
		Items []runtime.QuotaAccount `json:"items"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result.Items
}

func TestAgentQuotaOperationsRejectParametersAndShareOneRead(t *testing.T) {
	engine, client := runtimeRPCClient(t, runtime.NewFake())
	var calls atomic.Int32
	engine.QuotaSources = func() []runtime.QuotaSource {
		return []runtime.QuotaSource{
			{ID: "codex", Read: func(ctx context.Context) runtime.QuotaReading {
				calls.Add(1)
				if _, ok := ctx.Deadline(); !ok {
					t.Error("missing deadline")
				}
				return quotaTestReading("codex", "ok", "", 25)
			}},
			// An account the first operation never defined has no item on its wire.
			{ID: "later", Read: func(context.Context) runtime.QuotaReading {
				calls.Add(1)
				reading := quotaTestReading("later", "not_configured", "no_login", 0)
				reading.Legacy = nil
				return reading
			}},
		}
	}
	for _, op := range []string{"AgentQuota", "AgentQuotaV2", "AgentQuotaStream"} {
		if _, err := client.RPC(op, map[string]any{"path": "/secret"}); err == nil || !strings.Contains(err.Error(), "invalid_argument") {
			t.Fatalf("%s bad params: %v", op, err)
		}
	}
	for i := 0; i < 2; i++ {
		raw, err := client.RPC("AgentQuotaV2", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		items := quotaTestItems(t, raw)
		if len(items) != 2 || items[0].ID != "codex" || items[0].State != "ok" || *items[0].Meters[0].UsedPercent != 25 || !items[0].Meters[0].Headline ||
			items[1].State != "not_configured" || items[1].Reason != "no_login" || !strings.Contains(string(raw), `"meters":[]`) {
			t.Fatalf("%s", raw)
		}
		raw, err = client.RPC("AgentQuota", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), `"used_percent":25`) || !strings.Contains(string(raw), `"status":"ok"`) || strings.Contains(string(raw), "later") || strings.Contains(string(raw), "headline") {
			t.Fatalf("%s", raw)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("account read count %d", got)
	}
	raw, err := client.RPC("AgentQuotaStream", map[string]any{})
	if err != nil || !strings.Contains(string(raw), `"done":true`) || len(quotaTestItems(t, raw)) != 2 {
		t.Fatalf("stream final: %s, %v", raw, err)
	}
	// Each account ages on its own: only the one past a minute is read again.
	quotaTestAge(engine, "codex", 2*time.Minute)
	if _, err := client.RPC("AgentQuotaV2", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 3 {
		t.Fatalf("account read count after one aged: %d", got)
	}
}

// A session that is established warms the account cache before the phone asks
// for it, so the first quota view answers without waiting for the provider.
func TestAgentQuotaPrefetchMakesTheFirstViewFast(t *testing.T) {
	const providerTime = time.Second
	var calls atomic.Int32
	engine, client := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) {
		e.QuotaPrefetch = true
		e.QuotaSources = func() []runtime.QuotaSource {
			return []runtime.QuotaSource{{ID: "codex", Read: func(context.Context) runtime.QuotaReading {
				calls.Add(1)
				time.Sleep(providerTime)
				return quotaTestReading("codex", "ok", "", 25)
			}}}
		}
	})
	// The handshake started the warm read; wait for its result to be stored.
	deadline := time.Now().Add(3 * time.Second)
	for {
		engine.quotas.mu.Lock()
		entry := engine.quotas.entries["codex"]
		warm := entry != nil && entry.running == nil && !entry.sampled.IsZero()
		engine.quotas.mu.Unlock()
		if warm {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the established session did not warm the quota cache")
		}
		time.Sleep(time.Millisecond)
	}
	started := time.Now()
	raw, err := client.RPC("AgentQuotaV2", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	if got := calls.Load(); got != 1 {
		t.Fatalf("the first view read the provider again: %d reads", got)
	}
	if elapsed >= providerTime/10 {
		t.Fatalf("warm first view took %v, want under %v", elapsed, providerTime/10)
	}
	if !strings.Contains(string(raw), `"used_percent":25`) {
		t.Fatalf("%s", raw)
	}
}

func TestAgentQuotaConcurrentRefreshesShareTheReadInFlight(t *testing.T) {
	engine, client := runtimeRPCClient(t, runtime.NewFake())
	var calls atomic.Int32
	entered, release := make(chan struct{}, 4), make(chan struct{})
	engine.QuotaSources = func() []runtime.QuotaSource {
		return []runtime.QuotaSource{{ID: "codex", Read: func(context.Context) runtime.QuotaReading {
			calls.Add(1)
			entered <- struct{}{}
			<-release
			return quotaTestReading("codex", "ok", "", 40)
		}}}
	}
	var wg sync.WaitGroup
	results := make([]string, 3)
	for i, op := range []string{"AgentQuotaV2", "AgentQuota", "AgentQuotaV2"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			raw, err := client.RPC(op, map[string]any{})
			if err != nil {
				results[i] = err.Error()
				return
			}
			results[i] = string(raw)
		}()
	}
	<-entered
	// The other two requests are waiting on the read above, not refused.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	for i, result := range results {
		if !strings.Contains(result, `"used_percent":40`) {
			t.Fatalf("request %d: %s", i, result)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("started %d reads for one account", got)
	}
}

func TestAgentQuotaFailedReadKeepsTheLastSampleAndALostLoginDropsIt(t *testing.T) {
	engine, client := runtimeRPCClient(t, runtime.NewFake())
	next := quotaTestReading("codex", "ok", "", 28)
	engine.QuotaSources = func() []runtime.QuotaSource {
		return []runtime.QuotaSource{{ID: "codex", Read: func(context.Context) runtime.QuotaReading { return next }}}
	}
	read := func() runtime.QuotaAccount {
		t.Helper()
		raw, err := client.RPC("AgentQuotaV2", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		return quotaTestItems(t, raw)[0]
	}
	sampled := read().ObservedAt

	next = quotaTestReading("codex", "failed", "timeout", 0)
	quotaTestAge(engine, "codex", 2*time.Minute)
	got := read()
	if got.State != "failed" || got.Reason != "timeout" || got.ObservedAt != sampled || len(got.Meters) != 1 || *got.Meters[0].UsedPercent != 28 || got.Plan != "pro" {
		t.Fatalf("failed read lost the sample: %+v", got)
	}
	// The first wire has no way to say "old numbers": it reports the failure as before.
	raw, err := client.RPC("AgentQuota", map[string]any{})
	if err != nil || !strings.Contains(string(raw), `"status":"unavailable"`) || !strings.Contains(string(raw), `"windows":[]`) {
		t.Fatalf("%s %v", raw, err)
	}

	next = quotaTestReading("codex", "throttled", "", 0)
	next.Account.RetryAt = time.Now().Unix() + 600
	quotaTestAge(engine, "codex", 2*time.Minute)
	if got = read(); got.State != "throttled" || len(got.Meters) != 1 || got.RetryAt != next.Account.RetryAt {
		t.Fatalf("throttled read: %+v", got)
	}
	// Until the provider's own time, the account is not asked again.
	next = quotaTestReading("codex", "ok", "", 99)
	quotaTestAge(engine, "codex", 5*time.Minute)
	if got = read(); got.State != "throttled" {
		t.Fatalf("asked a throttling provider again: %+v", got)
	}
	quotaTestAge(engine, "codex", 5*time.Minute)
	engine.quotas.mu.Lock()
	engine.quotas.entries["codex"].reading.Account.RetryAt = time.Now().Unix() - 1
	engine.quotas.mu.Unlock()
	if got = read(); got.State != "ok" || *got.Meters[0].UsedPercent != 99 {
		t.Fatalf("%+v", got)
	}

	next = quotaTestReading("codex", "needs_action", "relogin", 0)
	quotaTestAge(engine, "codex", 2*time.Minute)
	if got = read(); got.State != "needs_action" || len(got.Meters) != 0 || got.ObservedAt != 0 {
		t.Fatalf("expired login kept numbers: %+v", got)
	}
	next = quotaTestReading("codex", "failed", "unavailable", 0)
	quotaTestAge(engine, "codex", 2*time.Minute)
	if got = read(); len(got.Meters) != 0 {
		t.Fatalf("numbers from before the login was lost came back: %+v", got)
	}
}
