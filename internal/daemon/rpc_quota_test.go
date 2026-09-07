package daemon

import (
	"context"
	"strings"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestAgentQuotaRPCRejectsParametersAndCachesAccountRead(t *testing.T) {
	engine, client := runtimeRPCClient(t, runtime.NewFake())
	calls := 0
	engine.QuotaReader = func(ctx context.Context) []runtime.AgentQuota {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("missing deadline")
		}
		return []runtime.AgentQuota{{Provider: "codex", Plan: "pro", Status: "ok", Source: "app_server", ObservedAt: time.Now().Unix(), Windows: []runtime.QuotaWindow{{Name: "codex", UsedPercent: 25, WindowMinutes: 300, ResetsAt: 2100000000}}}}
	}
	if _, err := client.RPC("AgentQuota", map[string]any{"path": "/secret"}); err == nil || !strings.Contains(err.Error(), "invalid_argument") {
		t.Fatalf("bad params: %v", err)
	}
	for i := 0; i < 2; i++ {
		raw, err := client.RPC("AgentQuota", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), `"used_percent":25`) {
			t.Fatalf("%s", raw)
		}
	}
	engine.quotas.mu.Lock()
	if calls != 1 {
		t.Fatalf("account read count %d", calls)
	}
	engine.quotas.mu.Unlock()
	engine.quotas.mu.Lock()
	_, err := client.RPC("AgentQuota", map[string]any{})
	engine.quotas.mu.Unlock()
	if err == nil || !strings.Contains(err.Error(), "rate_limited") {
		t.Fatalf("busy: %v", err)
	}
}
