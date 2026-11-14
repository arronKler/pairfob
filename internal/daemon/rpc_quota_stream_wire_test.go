package daemon

import (
	"context"
	"encoding/json"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestQuotaStreamEncryptedRPCDoesNotBlockOtherReads(t *testing.T) {
	e, client := runtimeRPCClient(t, runtime.NewFake())
	gate := make(chan struct{})
	defer close(gate)
	var calls atomic.Int32
	e.QuotaSources = func() []runtime.QuotaSource {
		return []runtime.QuotaSource{
			{ID: "codex", Read: func(context.Context) runtime.QuotaReading {
				calls.Add(1)
				<-gate
				return quotaTestReading("codex", "ok", "", 25)
			}},
			{ID: "copilot", Read: func(context.Context) runtime.QuotaReading {
				calls.Add(1)
				return quotaTestReading("copilot", "ok", "", 50)
			}},
		}
	}
	type answer struct {
		raw json.RawMessage
		err error
	}
	batch := make(chan answer, 1)
	go func() {
		raw, err := client.RPC("AgentQuotaV2", map[string]any{})
		batch <- answer{raw, err}
	}()
	// The Go phone deliberately consumes one response; here that exposes the
	// interim frame, whereas the browser keeps the request until done:true.
	raw, err := client.RPCTimeout("AgentQuotaStream", map[string]any{}, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var part struct {
		Items []runtime.QuotaAccount `json:"items"`
		Done  bool                   `json:"done"`
	}
	if err := json.Unmarshal(raw, &part); err != nil {
		t.Fatal(err)
	}
	if part.Done || len(part.Items) != 1 || part.Items[0].ID != "copilot" {
		t.Fatalf("unexpected progress: %s", raw)
	}
	select {
	case <-batch:
		t.Fatal("legacy batch returned before slow provider")
	default:
	}
	if _, err := client.RPCTimeout("Ping", map[string]any{"t_ms": 1}, time.Second); err != nil {
		t.Fatalf("other RPC blocked: %v", err)
	}
	gate <- struct{}{}
	final := <-batch
	if final.err != nil || len(quotaTestItems(t, final.raw)) != 2 || calls.Load() != 2 {
		t.Fatalf("batch failed or duplicated provider calls: err=%v calls=%d", final.err, calls.Load())
	}
}

// Real providers over the same encrypted v2 mux used by daemon integration
// tests. The Go phone consumes the first response, which can now be a login
// notice rather than numbers. This measures local routing, NOT public relay
// or physical-phone RTT; use TestQuotaStreamProfile for first numeric timing.
func TestQuotaStreamEncryptedProfile(t *testing.T) {
	if os.Getenv("PAIRFOB_PROFILE_QUOTA") != "1" {
		t.Skip("explicit local account timing only")
	}
	_, client := runtimeRPCClient(t, runtime.NewFake())
	start := time.Now()
	type outcome struct {
		elapsed time.Duration
		err     error
	}
	batch := make(chan outcome, 1)
	go func() {
		_, err := client.RPC("AgentQuotaV2", map[string]any{})
		batch <- outcome{time.Since(start), err}
	}()
	raw, err := client.RPC("AgentQuotaStream", map[string]any{})
	first := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	sampled, useful := false, false
	for _, account := range quotaTestItems(t, raw) {
		sampled = sampled || runtime.QuotaAccountSampled(account)
		useful = useful || account.State != "not_configured"
	}
	all := <-batch
	if all.err != nil || !useful {
		t.Fatalf("measurement unavailable: useful=%t error=%v", useful, all.err)
	}
	t.Logf("encrypted_mux_first_result_ms=%.3f first_result_has_sample=%t legacy_complete_ms=%.3f first_result_speedup=%.2fx", float64(first.Microseconds())/1000, sampled, float64(all.elapsed.Microseconds())/1000, float64(all.elapsed)/float64(first))
}
