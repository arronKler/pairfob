package runtime

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// quotaRead asks the provider for the allowance of a login already found.
type quotaRead func(context.Context) AgentQuota

// A quota provider reads in two steps. locate looks for the login on this
// computer and makes no request to the provider; with nothing to ask it
// returns no read and an item saying why. Only a located login is read.
type quotaProvider struct {
	name   string
	source string
	// spawns marks a read that starts a CLI process.
	spawns bool
	locate func(context.Context) (quotaRead, AgentQuota)
}

// The order is the order of the first AgentQuota operation's items.
var quotaProviders = []quotaProvider{
	{name: "codex", source: "app_server", spawns: true, locate: locateCodexQuota},
	{name: "claude", source: "oauth", locate: locateClaudeQuota},
	{name: "antigravity", source: "local_api", locate: locateAntigravityQuota},
	{name: "copilot", source: "github_api", locate: locateCopilotQuota},
	{name: "cursor", source: "web_api", locate: locateCursorQuota},
	{name: "grok", source: "oauth", locate: locateGrokQuota},
}

// quotaAccountRead asks a provider whose allowance is not a set of percentage
// windows; it builds the account's meters itself.
type quotaAccountRead func(context.Context) QuotaAccount

// A quotaAccountProvider is only on AgentQuotaV2: the first operation's six
// items are frozen, so a newer provider never appears there.
type quotaAccountProvider struct {
	name   string
	source string
	locate func(context.Context) (quotaAccountRead, AgentQuota)
}

var quotaAccountProviders = []quotaAccountProvider{
	{name: "deepseek", source: "api", locate: locateDeepSeekQuota},
	{name: "opencode-go", source: "api", locate: locateOpenCodeGoQuota},
	{name: "command-code", source: "api", locate: locateCommandCodeQuota},
}

// Reads that start a CLI share these slots. HTTP reads are not limited: run
// together, the batch takes as long as its slowest provider and nothing queues.
var quotaSpawnSlots = make(chan struct{}, 3)

// QuotaSource reads one account. Sources are independent of one another, so a
// caller may cache, share and time each on its own.
type QuotaSource struct {
	ID   string
	Read func(context.Context) QuotaReading
}

// QuotaSources lists the accounts this build can read, configured or not.
func QuotaSources() []QuotaSource {
	selected, err := QuotaSelection()
	if err != nil {
		return nil
	}
	enabled := map[string]bool{}
	for _, name := range selected {
		enabled[name] = true
	}
	out := make([]QuotaSource, 0, len(quotaProviders)+len(quotaAccountProviders))
	for _, p := range quotaProviders {
		if !enabled[p.name] {
			continue
		}
		out = append(out, QuotaSource{ID: p.name, Read: p.read})
	}
	for _, p := range quotaAccountProviders {
		if !enabled[p.name] {
			continue
		}
		out = append(out, QuotaSource{ID: p.name, Read: p.read})
	}
	return out
}

// ReadQuotaAccounts reads every source once, together, with no cache. It only
// reads the daemon user's locally configured accounts.
func ReadQuotaAccounts(ctx context.Context) []QuotaReading {
	sources := QuotaSources()
	out := make([]QuotaReading, len(sources))
	var wg sync.WaitGroup
	for i, source := range sources {
		wg.Add(1)
		go func() { defer wg.Done(); out[i] = source.Read(ctx) }()
	}
	wg.Wait()
	return out
}

func (p quotaProvider) read(parent context.Context) QuotaReading {
	note := &quotaNote{}
	ctx := context.WithValue(parent, quotaNoteKey{}, note)
	read, q := p.locate(ctx)
	if read != nil {
		q = p.ask(ctx, read)
	}
	legacy := legacyQuota(q)
	account := quotaAccount(q)
	if account.State == "throttled" {
		account.RetryAt = note.retry()
	}
	return QuotaReading{Account: account, Legacy: &legacy}
}

// read is the same two steps for an account provider. It has no first-operation
// item, so Legacy stays nil and an older phone never sees a seventh item.
func (p quotaAccountProvider) read(parent context.Context) QuotaReading {
	note := &quotaNote{}
	ctx := context.WithValue(parent, quotaNoteKey{}, note)
	locate, q := p.locate(ctx)
	account := quotaAccount(q)
	if locate != nil {
		account = locate(ctx)
		if account.State == "failed" && account.Reason == "unavailable" && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			account.Reason = "timeout"
		}
	}
	if account.State == "throttled" {
		account.RetryAt = note.retry()
	}
	return QuotaReading{Account: account}
}

func (p quotaProvider) ask(ctx context.Context, read quotaRead) AgentQuota {
	if p.spawns {
		select {
		case quotaSpawnSlots <- struct{}{}:
			defer func() { <-quotaSpawnSlots }()
		case <-ctx.Done():
			return emptyQuota(p.name, p.source, "timeout")
		}
	}
	q := read(ctx)
	if q.Status == "unavailable" && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		q.Status = "timeout"
	}
	return q
}

// quotaPool turns a provider's own bucket name into a pool token.
func quotaPool(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if b.Len() == 64 {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.WriteByte('-')
		}
	}
	pool := strings.TrimRight(b.String(), "-")
	if pool == "" {
		return "other"
	}
	return pool
}

// quotaNote carries what a read learned beside its item: when a provider that
// refused for rate asked to be left alone until, and whether a refusal was a
// 403 rather than a 401.
type quotaNoteKey struct{}

type quotaNote struct {
	mu        sync.Mutex
	retryAt   int64
	forbidden bool
}

func noteQuotaForbidden(ctx context.Context) {
	if note, ok := ctx.Value(quotaNoteKey{}).(*quotaNote); ok {
		note.mu.Lock()
		note.forbidden = true
		note.mu.Unlock()
	}
}

// quotaForbidden reports whether this read was refused with a 403.
func quotaForbidden(ctx context.Context) bool {
	note, ok := ctx.Value(quotaNoteKey{}).(*quotaNote)
	if !ok {
		return false
	}
	note.mu.Lock()
	defer note.mu.Unlock()
	return note.forbidden
}

func (n *quotaNote) retry() int64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.retryAt
}

// noteQuotaRetry records a Retry-After, in seconds or as a date, held to
// between a minute and an hour. A header that says neither records nothing.
func noteQuotaRetry(ctx context.Context, header string, now time.Time) {
	note, ok := ctx.Value(quotaNoteKey{}).(*quotaNote)
	if !ok {
		return
	}
	var wait time.Duration
	if seconds, err := strconv.Atoi(strings.TrimSpace(header)); err == nil && seconds >= 0 {
		wait = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(header); err == nil {
		wait = at.Sub(now)
	} else {
		return
	}
	wait = min(max(wait, time.Minute), time.Hour)
	note.mu.Lock()
	note.retryAt = now.Add(wait).Unix()
	note.mu.Unlock()
}
