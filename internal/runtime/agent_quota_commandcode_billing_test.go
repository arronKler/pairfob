package runtime

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCommandCodeBillingOverlapsAfterOrganisationDiscovery(t *testing.T) {
	base := commandCodeFixture(t).Transport
	started := make(chan string, 2)
	release := make(chan struct{})
	defer close(release)
	var discovered atomic.Bool
	c := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/alpha/whoami" {
			response, err := base.RoundTrip(r)
			discovered.Store(true)
			return response, err
		}
		if !discovered.Load() {
			t.Error("billing ran before discovery")
		}
		started <- r.URL.Path
		<-release
		return base.RoundTrip(r)
	})}
	done := make(chan QuotaAccount, 1)
	go func() {
		done <- fetchCommandCodeQuota(context.Background(), c, "user_test-key", time.Unix(1800000000, 0))
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("billing calls still serial")
		}
	}
	release <- struct{}{}
	release <- struct{}{}
	if account := <-done; account.State != "ok" || len(account.Meters) != 3 {
		t.Fatalf("%+v", account)
	}
}

func TestCommandCodeParallelFailuresKeepOriginalPriorityAndNotes(t *testing.T) {
	for _, tc := range []struct {
		credits, plan int
		state         string
		forbidden     bool
		retry         bool
	}{
		{401, 429, "needs_action", false, false},
		{403, 429, "needs_action", true, false},
		{500, 403, "failed", false, false},
		{429, 403, "throttled", false, true},
		{200, 429, "throttled", false, true},
		{200, 403, "needs_action", true, false},
	} {
		note := &quotaNote{}
		ctx := context.WithValue(context.Background(), quotaNoteKey{}, note)
		planDone := make(chan struct{})
		c := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
			code, body := 200, commandCodeWhoamiBody
			switch r.URL.Path {
			case "/alpha/billing/subscriptions":
				code, body = tc.plan, commandCodeSubscriptionBody
				defer close(planDone)
			case "/alpha/billing/credits":
				<-planDone
				code, body = tc.credits, commandCodeCreditsBody
			}
			return &http.Response{StatusCode: code, Header: http.Header{"Retry-After": []string{"120"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		})}
		account := fetchCommandCodeQuota(ctx, c, "user_test-key", time.Now())
		note.mu.Lock()
		forbidden, retry := note.forbidden, note.retryAt > 0
		note.mu.Unlock()
		if account.State != tc.state || forbidden != tc.forbidden || retry != tc.retry {
			t.Fatalf("%+v account=%+v forbidden=%v retry=%v", tc, account, forbidden, retry)
		}
	}
}

func TestCommandCodeCreditsFailureCancelsSpeculativePlan(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	base := commandCodeClient(t, 200, 401, 200, map[string]string{"/alpha/whoami": commandCodeWhoamiBody}).Transport
	c := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/subscriptions") {
			close(started)
			<-r.Context().Done()
			close(canceled)
			return nil, r.Context().Err()
		}
		if strings.HasSuffix(r.URL.Path, "/credits") {
			<-started
		}
		return base.RoundTrip(r)
	})}
	if account := fetchCommandCodeQuota(context.Background(), c, "user_test-key", time.Now()); account.State != "needs_action" {
		t.Fatalf("%+v", account)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("plan request not canceled")
	}
}

// A controlled latency comparison: same responses and three HTTP calls, with
// the old single-request-at-a-time constraint versus overlapping billing reads.
func TestCommandCodeBillingControlledLatency(t *testing.T) {
	var previous QuotaAccount
	for _, serial := range []bool{true, false} {
		base := commandCodeFixture(t).Transport
		var mu sync.Mutex
		var count atomic.Int32
		c := &http.Client{Transport: quotaRoundTrip(func(r *http.Request) (*http.Response, error) {
			if serial {
				mu.Lock()
				defer mu.Unlock()
			}
			count.Add(1)
			time.Sleep(80 * time.Millisecond)
			return base.RoundTrip(r)
		})}
		begin := time.Now()
		account := fetchCommandCodeQuota(context.Background(), c, "user_test-key", time.Unix(1800000000, 0))
		t.Logf("serialized=%v elapsed=%s calls=%d", serial, time.Since(begin), count.Load())
		if account.State != "ok" || count.Load() != 3 {
			t.Fatalf("%+v calls=%d", account, count.Load())
		}
		if !serial && !reflect.DeepEqual(previous, account) {
			t.Fatal("parallel result differs")
		}
		previous = account
	}
}
