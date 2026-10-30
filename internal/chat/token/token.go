// Package token keeps the pairfob-chat=<id> token on one Herdr pane alive.
// A crash loses the token within one TTL; a clean exit clears it.
package token

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	// TTLMillis is the expiry Herdr applies to a reported token.
	TTLMillis = 60000
	// Refresh is how often the token is reported again.
	Refresh = 20 * time.Second
	// clearTimeout bounds the cleanup call on a clean exit.
	clearTimeout = 5 * time.Second

	source = "pairfob-chat"
)

// Runner executes one Herdr command. Tests replace it.
type Runner func(ctx context.Context, bin string, args ...string) error

// Options configures the heartbeat. An empty PaneID disables it.
type Options struct {
	PaneID string
	// Bin is the herdr executable; empty means $HERDR_BIN_PATH, then "herdr".
	Bin string
	// Token is the full pane token, "pairfob-chat=<id>".
	Token string
	// Interval overrides Refresh.
	Interval time.Duration
	// Run overrides the exec runner.
	Run Runner
	// Logf reports a failed report or clear; defaults to stderr.
	Logf func(format string, args ...any)
}

// Heartbeat reports one pane token until stopped.
type Heartbeat struct {
	opts Options

	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

// Start reports the token immediately, then on every interval, until Stop.
// It never blocks the caller and never returns an error: a missing or failing
// Herdr only gets logged.
func Start(ctx context.Context, opts Options) *Heartbeat {
	if opts.Interval <= 0 {
		opts.Interval = Refresh
	}
	if opts.Bin == "" {
		opts.Bin = os.Getenv("HERDR_BIN_PATH")
	}
	if opts.Bin == "" {
		opts.Bin = "herdr"
	}
	if opts.Run == nil {
		opts.Run = execRunner
	}
	if opts.Logf == nil {
		opts.Logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "pairfob-chat: "+format+"\n", args...)
		}
	}
	hb := &Heartbeat{
		opts: opts,
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}
	if opts.PaneID == "" || opts.Token == "" {
		close(hb.done)
		return hb
	}
	go hb.loop(ctx)
	return hb
}

// Stop ends the heartbeat and clears the pane token. It is safe to call more
// than once and on a disabled heartbeat.
func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() {
		close(h.stop)
		<-h.done
		h.clear()
	})
}

func (h *Heartbeat) loop(ctx context.Context) {
	defer close(h.done)
	h.report(ctx)
	ticker := time.NewTicker(h.opts.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			h.report(ctx)
		case <-h.stop:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (h *Heartbeat) report(ctx context.Context) {
	args := []string{
		"pane", "report-metadata", h.opts.PaneID,
		"--source", source,
		"--agent", source,
		"--token", h.opts.Token,
		"--ttl-ms", fmt.Sprint(TTLMillis),
	}
	if err := h.opts.Run(ctx, h.opts.Bin, args...); err != nil {
		h.opts.Logf("report pane token: %v", err)
	}
}

// clear removes the token on a clean exit. It uses its own timeout because the
// session context may already be canceled.
func (h *Heartbeat) clear() {
	if h.opts.PaneID == "" || h.opts.Token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), clearTimeout)
	defer cancel()
	args := []string{
		"pane", "report-metadata", h.opts.PaneID,
		"--source", source,
		"--agent", source,
		"--clear-token", tokenKey(h.opts.Token),
	}
	if err := h.opts.Run(ctx, h.opts.Bin, args...); err != nil {
		h.opts.Logf("clear pane token: %v", err)
	}
}

// tokenKey returns "pairfob-chat" from "pairfob-chat=<id>".
func tokenKey(token string) string {
	key, _, _ := strings.Cut(token, "=")
	return key
}

// NewToken builds the pane token for one chat id.
func NewToken(id string) string {
	return "pairfob-chat=" + id
}

func execRunner(ctx context.Context, bin string, args ...string) error {
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
