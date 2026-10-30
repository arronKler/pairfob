package token

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

type call struct {
	bin  string
	args []string
}

type fakeRunner struct {
	mu    sync.Mutex
	calls []call
	err   error
}

func (f *fakeRunner) run(_ context.Context, bin string, args ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call{bin: bin, args: append([]string(nil), args...)})
	return f.err
}

func (f *fakeRunner) seen() []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]call(nil), f.calls...)
}

func waitCalls(t *testing.T, runner *fakeRunner, want int) []call {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if calls := runner.seen(); len(calls) >= want {
			return calls
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d Herdr calls, saw %d", want, len(runner.seen()))
	return nil
}

func TestHeartbeatReportsAndClears(t *testing.T) {
	runner := &fakeRunner{}
	heartbeat := Start(context.Background(), Options{
		PaneID:   "w1:p1",
		Bin:      "/opt/herdr",
		Token:    NewToken("0123456789abcdef"),
		Interval: 2 * time.Millisecond,
		Run:      runner.run,
		Logf:     func(string, ...any) {},
	})
	calls := waitCalls(t, runner, 2)
	heartbeat.Stop()

	report := calls[0]
	wantArgs := []string{
		"pane", "report-metadata", "w1:p1",
		"--source", "pairfob-chat", "--agent", "pairfob-chat",
		"--token", "pairfob-chat=0123456789abcdef",
		"--ttl-ms", "60000",
	}
	if report.bin != "/opt/herdr" {
		t.Fatalf("bin = %q", report.bin)
	}
	if !slices.Equal(report.args, wantArgs) {
		t.Fatalf("args = %q, want %q", report.args, wantArgs)
	}

	calls = runner.seen()
	clear := calls[len(calls)-1]
	if !slices.Contains(clear.args, "--clear-token") {
		t.Fatalf("last call did not clear the token: %q", clear.args)
	}
	if !slices.Contains(clear.args, "pairfob-chat") {
		t.Fatalf("clear call names no token key: %q", clear.args)
	}
	if slices.Contains(clear.args, "--token") || slices.Contains(clear.args, "--ttl-ms") {
		t.Fatalf("clear call still reports a token: %q", clear.args)
	}

	before := len(runner.seen())
	heartbeat.Stop()
	if after := len(runner.seen()); after != before {
		t.Fatalf("second Stop ran %d more commands", after-before)
	}
}

func TestHeartbeatDisabledWithoutPane(t *testing.T) {
	runner := &fakeRunner{}
	heartbeat := Start(context.Background(), Options{
		Token:    NewToken("0123456789abcdef"),
		Interval: time.Millisecond,
		Run:      runner.run,
		Logf:     func(string, ...any) {},
	})
	time.Sleep(10 * time.Millisecond)
	heartbeat.Stop()
	if calls := runner.seen(); len(calls) != 0 {
		t.Fatalf("disabled heartbeat ran %+v", calls)
	}
}

func TestHeartbeatFailuresAreLogged(t *testing.T) {
	runner := &fakeRunner{err: errors.New("herdr is not running")}
	var mu sync.Mutex
	var logs []string
	heartbeat := Start(context.Background(), Options{
		PaneID:   "w1:p1",
		Token:    NewToken("0123456789abcdef"),
		Interval: time.Millisecond,
		Run:      runner.run,
		Logf: func(format string, args ...any) {
			mu.Lock()
			logs = append(logs, format)
			mu.Unlock()
		},
	})
	waitCalls(t, runner, 1)
	heartbeat.Stop()

	mu.Lock()
	defer mu.Unlock()
	if len(logs) < 2 {
		t.Fatalf("logs = %+v, want a report and a clear failure", logs)
	}
	if logs[0] != "report pane token: %v" && logs[0] != "clear pane token: %v" {
		t.Fatalf("unexpected log format %q", logs[0])
	}
}

func TestTokenKey(t *testing.T) {
	if key := tokenKey(NewToken("abc")); key != "pairfob-chat" {
		t.Fatalf("key = %q", key)
	}
}
