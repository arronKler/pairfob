package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/daemon"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"pairfob/internal/wsnet"
)

func TestRelayReconnectBackoff(t *testing.T) {
	tests := []struct {
		name         string
		connectedFor time.Duration
		current      time.Duration
		wantDelay    time.Duration
		wantNext     time.Duration
	}{
		{name: "stable reconnects immediately", connectedFor: relayStableConnection, current: time.Second, wantDelay: 0, wantNext: time.Second},
		{name: "stable resets high backoff", connectedFor: relayStableConnection, current: 16 * time.Second, wantDelay: 0, wantNext: time.Second},
		{name: "unstable keeps backoff", connectedFor: relayStableConnection - time.Millisecond, current: time.Second, wantDelay: time.Second, wantNext: 2 * time.Second},
		{name: "unstable caps backoff", connectedFor: 0, current: 30 * time.Second, wantDelay: 30 * time.Second, wantNext: 30 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			delay, next := relayReconnectBackoff(tt.connectedFor, tt.current)
			if delay != tt.wantDelay || next != tt.wantNext {
				t.Fatalf("relayReconnectBackoff() = (%s, %s), want (%s, %s)", delay, next, tt.wantDelay, tt.wantNext)
			}
		})
	}
}

func TestJitterBackoffStaysBounded(t *testing.T) {
	if got := jitterBackoff(0); got != 0 {
		t.Fatalf("jitterBackoff(0)=%s", got)
	}
	if got := jitterBackoffN(-time.Second, func(int64) int64 { return 0 }); got != 0 {
		t.Fatalf("negative delay jittered to %s", got)
	}
	if got := jitterBackoffN(2*time.Second, func(int64) int64 { return 0 }); got != time.Second {
		t.Fatalf("min equal jitter=%s, want 1s", got)
	}
	if got := jitterBackoffN(2*time.Second, func(n int64) int64 { return n - 1 }); got != 2*time.Second {
		t.Fatalf("max equal jitter=%s, want 2s", got)
	}
	if got := jitterBackoffN(2*time.Second, func(int64) int64 { return -9 }); got < 0 || got > relayMaxBackoff {
		t.Fatalf("negative roll %s is out of cap", got)
	}
	if got := jitterBackoffN(2*time.Second, func(int64) int64 { return 1 << 62 }); got < 0 || got > relayMaxBackoff {
		t.Fatalf("huge roll %s is out of cap", got)
	}
	if got := jitterBackoffN(time.Minute, func(n int64) int64 { return n - 1 }); got != relayMaxBackoff {
		t.Fatalf("over-cap delay jittered to %s, want %s", got, relayMaxBackoff)
	}
	for i := 0; i < 32; i++ {
		got := jitterBackoff(relayMaxBackoff)
		if got < 0 || got > relayMaxBackoff {
			t.Fatalf("live jitter %s is out of cap", got)
		}
	}
}

func TestWaitRelayBackoffCancel(t *testing.T) {
	stop := make(chan struct{})
	close(stop)
	if waitRelayBackoff(time.Minute, stop) {
		t.Fatal("closed stop must skip a long delay")
	}
	if !waitRelayBackoff(0, nil) {
		t.Fatal("zero delay with no stop must continue")
	}
}

func TestRunRelayShortRegisteredConnectionsGrowBackoff(t *testing.T) {
	url, _ := startRegisterRelay(t, nil)
	stop := make(chan struct{})
	h := newRelayHarness(stop)
	startTestRelay(t, url, stop, h.retry)
	got := h.waitDelays(t, 3)
	close(stop)
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	for i, delay := range want {
		if got[i] != delay {
			t.Fatalf("short-link delays=%v, want %v", got, want)
		}
	}
}

func TestRunRelayStableLinkResetsBackoff(t *testing.T) {
	holdThird := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-holdThird:
		default:
			close(holdThird)
		}
	})
	url, registered := startRegisterRelay(t, func(seq int) <-chan struct{} {
		if seq == 3 {
			return holdThird
		}
		return nil
	})
	stop := make(chan struct{})
	h := newRelayHarness(stop)
	startTestRelay(t, url, stop, h.retry)
	got := h.waitDelays(t, 2)
	if got[0] != time.Second || got[1] != 2*time.Second {
		t.Fatalf("pre-stable delays=%v, want 1s then 2s", got)
	}
	waitRegistered(t, registered, 3)
	h.waitNow(t, 5)
	h.advance(relayStableConnection)
	close(holdThird)
	got = append(got, h.waitDelays(t, 2)...)
	close(stop)
	want := []time.Duration{time.Second, 2 * time.Second, 0, time.Second}
	for i, delay := range want {
		if got[i] != delay {
			t.Fatalf("stable-reset delays=%v, want %v", got, want)
		}
	}
}

func TestRunRelayStopsDuringBackoffWait(t *testing.T) {
	url, _ := startRegisterRelay(t, nil)
	eng, link := testRelayEngine(t)
	stop := make(chan struct{})
	ready := make(chan error, 1)
	done := make(chan struct{})
	waiting := make(chan struct{})
	var once sync.Once
	retry := relayRetry{
		now:    time.Now,
		jitter: func(d time.Duration) time.Duration { return d },
		wait: func(d time.Duration, waitStop <-chan struct{}) bool {
			if d <= 0 {
				select {
				case <-waitStop:
					return false
				default:
					return true
				}
			}
			once.Do(func() { close(waiting) })
			select {
			case <-waitStop:
				return false
			case <-stop:
				return false
			}
		},
	}
	go func() {
		defer close(done)
		runRelayWith(link, eng, url, "", ready, stop, retry)
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first registration did not complete")
	}
	select {
	case <-waiting:
	case <-time.After(2 * time.Second):
		t.Fatal("backoff wait did not start")
	}
	stopRelay(stop, link)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runRelay did not stop after cancellation")
	}
}

type relayHarness struct {
	retry   relayRetry
	delayCh chan time.Duration
	nowCh   chan int64
	nowN    atomic.Int64
	clockMu sync.Mutex
	clock   time.Time
}

func newRelayHarness(stop <-chan struct{}) *relayHarness {
	h := &relayHarness{
		delayCh: make(chan time.Duration, 16),
		nowCh:   make(chan int64, 32),
		clock:   time.Unix(1_700_000_000, 0),
	}
	h.retry = relayRetry{
		now: func() time.Time {
			h.clockMu.Lock()
			sampled := h.clock
			// Publish the count only after the sample so waitNow cannot
			// advance the clock before connectedAt is captured.
			n := h.nowN.Add(1)
			h.clockMu.Unlock()
			select {
			case h.nowCh <- n:
			default:
			}
			return sampled
		},
		jitter: func(d time.Duration) time.Duration { return d },
		wait: func(d time.Duration, waitStop <-chan struct{}) bool {
			select {
			case <-waitStop:
				return false
			case <-stop:
				return false
			default:
			}
			select {
			case h.delayCh <- d:
			case <-waitStop:
				return false
			case <-stop:
				return false
			}
			select {
			case <-waitStop:
				return false
			case <-stop:
				return false
			default:
				return true
			}
		},
	}
	return h
}

func (h *relayHarness) advance(d time.Duration) {
	h.clockMu.Lock()
	h.clock = h.clock.Add(d)
	h.clockMu.Unlock()
}

func (h *relayHarness) waitDelays(t *testing.T, n int) []time.Duration {
	t.Helper()
	out := make([]time.Duration, 0, n)
	for len(out) < n {
		select {
		case d := <-h.delayCh:
			out = append(out, d)
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for delay %d; got %v", n, out)
		}
	}
	return out
}

func (h *relayHarness) waitNow(t *testing.T, n int64) {
	t.Helper()
	if h.nowN.Load() >= n {
		return
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case got := <-h.nowCh:
			if got >= n || h.nowN.Load() >= n {
				return
			}
		case <-deadline:
			t.Fatalf("now count %d, want >= %d", h.nowN.Load(), n)
		}
	}
}

func stopRelay(stop chan struct{}, link *relayLink) {
	select {
	case <-stop:
	default:
		close(stop)
	}
	if link == nil {
		return
	}
	if conn := link.get(); conn != nil {
		conn.Close()
	}
}

func startTestRelay(t *testing.T, url string, stop chan struct{}, retry relayRetry) {
	t.Helper()
	eng, link := testRelayEngine(t)
	ready := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runRelayWith(link, eng, url, "", ready, stop, retry)
	}()
	t.Cleanup(func() {
		stopRelay(stop, link)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("runRelay did not stop")
		}
	})
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first registration did not complete")
	}
}

func testRelayEngine(t *testing.T) (*daemon.Engine, *relayLink) {
	t.Helper()
	engPipe, relayPipe := mux.NewPipePair(8)
	t.Cleanup(func() {
		engPipe.Close()
		relayPipe.Close()
	})
	eng := daemon.NewEngine(nil, engPipe, runtime.NewFake())
	eng.MuxProtocol = 2
	eng.DaemonID = "d_0123456789abcdef0123"
	eng.Reconnect = "rt_" + strings.Repeat("ab", 16)
	return eng, newRelayLink(relayPipe)
}

func startRegisterRelay(t *testing.T, hold func(seq int) <-chan struct{}) (string, <-chan int) {
	t.Helper()
	var mu sync.Mutex
	seq := 0
	registered := make(chan int, 32)
	released := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := wsnet.UpgraderFor(wsnet.SubprotocolV2)
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := wsnet.Wrap(ws)
		defer conn.Close()
		frame, err := conn.Recv()
		if err != nil || frame.Typ != envelope.TypHELLO_DAEMON {
			return
		}
		if err := conn.Send(envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{
			"ok": true, "daemon_id": "d_0123456789abcdef0123", "reconnect_token": "rt_" + strings.Repeat("ab", 16),
		})); err != nil {
			return
		}
		mu.Lock()
		seq++
		n := seq
		mu.Unlock()
		registered <- n
		if hold != nil {
			if wait := hold(n); wait != nil {
				select {
				case <-wait:
				case <-released:
				}
			}
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(released) })
	return "ws" + strings.TrimPrefix(server.URL, "http"), registered
}

func waitRegistered(t *testing.T, registered <-chan int, n int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case got := <-registered:
			if got >= n {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for registration %d", n)
		}
	}
}
