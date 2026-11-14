package daemon

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestQuotaWaiterCancellationPreservesOwner(t *testing.T) {
	var cache quotaCache
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	source := runtime.QuotaSource{ID: "codex", Read: func(context.Context) runtime.QuotaReading {
		calls.Add(1)
		close(started)
		<-release
		return quotaTestReading("codex", "ok", "", 25)
	}}
	owner := make(chan error, 1)
	go func() { _, err := cache.read(context.Background(), source); owner <- err }()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	begin := time.Now()
	done := make(chan error, 1)
	go func() { _, err := cache.read(ctx, source); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		t.Logf("waiter deadline=20ms returned=%s, owner still running", time.Since(begin))
	case <-time.After(time.Second):
		t.Fatal("waiter ignored its deadline")
	}
	select {
	case <-owner:
		t.Fatal("waiter canceled the owner")
	default:
	}
	// Release without closing: the deferred close also unblocks failure paths.
	release <- struct{}{}
	if err := <-owner; err != nil {
		t.Fatal(err)
	}
	reading, err := cache.read(context.Background(), source)
	if err != nil || reading.Account.State != "ok" || calls.Load() != 1 {
		t.Fatalf("%+v %v calls=%d", reading, err, calls.Load())
	}
}

func TestQuotaBatchDeadlineDoesNotPublishEmptySuccess(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	e := Engine{QuotaSources: func() []runtime.QuotaSource {
		return []runtime.QuotaSource{{ID: "codex", Read: func(context.Context) runtime.QuotaReading {
			<-release
			return quotaTestReading("codex", "ok", "", 25)
		}}}
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	readings, err := e.quotaBatchContext(ctx, nil)
	if !errors.Is(err, context.DeadlineExceeded) || readings != nil {
		t.Fatalf("%+v %v", readings, err)
	}
}

func TestQuotaProgressOnlyWakesForUsefulResults(t *testing.T) {
	var frames [][]runtime.QuotaAccount
	p := quotaProgress{send: func(items []runtime.QuotaAccount) { frames = append(frames, items) }}
	defer p.stop()
	if p.due != nil {
		t.Fatal("timer armed without results")
	}
	p.add(quotaTestReading("codex", "not_configured", "no_login", 0).Account)
	if p.due != nil {
		t.Fatal("missing login alone armed timer")
	}
	p.add(quotaTestReading("copilot", "needs_action", "relogin", 0).Account)
	select {
	case <-p.due:
		p.flush()
	case <-time.After(time.Second):
		t.Fatal("login error waited for numbers")
	}
	if len(frames) != 1 || len(frames[0]) != 2 || p.due != nil || p.pending != nil {
		t.Fatalf("%+v", p)
	}
	// Three error-only updates leave a slot for the first useful numbers.
	for i := 0; i < 2; i++ {
		p.add(quotaTestReading("copilot", "failed", "unavailable", 0).Account)
		<-p.due
		p.flush()
	}
	p.add(quotaTestReading("copilot", "failed", "unavailable", 0).Account)
	if p.due != nil {
		t.Fatal("last slot consumed before numbers")
	}
	p.add(quotaTestReading("codex", "ok", "", 25).Account)
	<-p.due
	p.flush()
	p.add(quotaTestReading("codex", "ok", "", 25).Account)
	if len(frames) != 4 || p.due != nil {
		t.Fatal("frame budget exceeded")
	}
}
