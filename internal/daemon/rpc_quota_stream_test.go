package daemon

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestQuotaProgressDoesNotWaitForSlowProviderOrRepeatReads(t *testing.T) {
	var calls atomic.Int32
	gate := make(chan struct{})
	defer close(gate)
	e := &Engine{QuotaSources: func() []runtime.QuotaSource {
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
	}}
	first := make(chan []runtime.QuotaAccount, 1)
	done := make(chan []runtime.QuotaReading, 1)
	go func() { done <- e.quotaReadingsProgress(func(items []runtime.QuotaAccount) { first <- items }) }()
	select {
	case items := <-first:
		if len(items) != 1 || items[0].ID != "copilot" {
			t.Fatalf("unexpected early accounts: %v", items)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("fast account blocked on slow account")
	}
	select {
	case <-done:
		t.Fatal("completed while provider still running")
	default:
	}
	gate <- struct{}{}
	out := <-done
	if len(out) != 2 || out[0].Account.ID != "codex" || out[1].Account.ID != "copilot" {
		t.Fatal("final ordering changed")
	}
	warm := e.quotaReadingsProgress(func([]runtime.QuotaAccount) { t.Error("warm cache needs no deltas") })
	if len(warm) != 2 || calls.Load() != 2 {
		t.Fatalf("repeated provider reads: %d", calls.Load())
	}
}

func TestQuotaProgressHasBoundedFramesAndKeepsEveryFinalAccount(t *testing.T) {
	const count = 9
	e := &Engine{QuotaSources: func() []runtime.QuotaSource {
		out := make([]runtime.QuotaSource, count)
		for i := range out {
			id := string(rune('a' + i))
			out[i] = runtime.QuotaSource{ID: id, Read: func(context.Context) runtime.QuotaReading {
				time.Sleep(time.Duration(i) * 85 * time.Millisecond)
				return quotaTestReading(id, "ok", "", 25)
			}}
		}
		return out
	}}
	frames := 0
	out := e.quotaReadingsProgress(func([]runtime.QuotaAccount) { frames++ })
	if frames < 1 || frames > 4 || len(out) != count {
		t.Fatalf("frames=%d accounts=%d", frames, len(out))
	}
}

// Local real-account measurement: baseline and incremental visibility use the
// SAME cold batch, so provider/network variation cannot manufacture a speedup.
func TestQuotaStreamProfile(t *testing.T) {
	if os.Getenv("PAIRFOB_PROFILE_QUOTA") != "1" {
		t.Skip("explicit local account timing only")
	}
	e := &Engine{}
	start := time.Now()
	first, frames := time.Duration(0), 0
	readings := e.quotaReadingsProgress(func(items []runtime.QuotaAccount) {
		frames++
		for _, item := range items {
			if first == 0 && runtime.QuotaAccountSampled(item) {
				first = time.Since(start)
			}
		}
	})
	all := time.Since(start)
	if first == 0 {
		first = all
	}
	t.Logf("real_accounts=%d first_sample_ms=%.3f all_complete_ms=%.3f first_sample_speedup=%.2fx interim_frames=%d", len(readings), float64(first.Microseconds())/1000, float64(all.Microseconds())/1000, float64(all)/float64(first), frames)
	start = time.Now()
	e.quotaReadingsProgress(func([]runtime.QuotaAccount) { t.Error("warm cache streamed") })
	t.Logf("warm_batch_ms=%.3f", float64(time.Since(start).Microseconds())/1000)
}
