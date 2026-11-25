package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"pairfob/internal/runtime"
)

const (
	quotaFreshFor  = time.Minute
	quotaBatchTime = 9 * time.Second
)

// quotaCache keeps one entry per account, so a slow or failing provider never
// decides how fresh another's numbers are, and both quota operations answer
// from the same read.
type quotaCache struct {
	mu      sync.Mutex
	entries map[string]*quotaEntry
}

type quotaEntry struct {
	reading runtime.QuotaReading
	sampled time.Time
	// good is the last read that produced numbers, kept for a read that fails.
	good *runtime.QuotaAccount
	// running is closed when the read in flight has stored its result.
	running chan struct{}
}

func (entry *quotaEntry) fresh(now time.Time) bool {
	if entry.sampled.IsZero() {
		return false
	}
	// A provider that asked to be left alone is not asked again before then.
	return now.Sub(entry.sampled) < quotaFreshFor ||
		(entry.reading.Account.State == "throttled" && now.Unix() < entry.reading.Account.RetryAt)
}

// read returns the account's reading: the cached one while it is fresh, the
// result of a read already in flight, or a new read. Two phones refreshing
// together share one read rather than starting a second process or request.
func (c *quotaCache) read(ctx context.Context, source runtime.QuotaSource) (runtime.QuotaReading, error) {
	for {
		if err := ctx.Err(); err != nil {
			return runtime.QuotaReading{}, err
		}
		c.mu.Lock()
		if c.entries == nil {
			c.entries = map[string]*quotaEntry{}
		}
		entry := c.entries[source.ID]
		if entry == nil {
			entry = &quotaEntry{}
			c.entries[source.ID] = entry
		}
		if entry.fresh(time.Now()) {
			reading := entry.reading
			c.mu.Unlock()
			return reading, nil
		}
		if running := entry.running; running != nil {
			c.mu.Unlock()
			select {
			case <-running:
				continue
			case <-ctx.Done():
				return runtime.QuotaReading{}, ctx.Err()
			}
		}
		running := make(chan struct{})
		entry.running = running
		c.mu.Unlock()

		reading := source.Read(ctx)
		now := time.Now()
		c.mu.Lock()
		switch {
		case runtime.QuotaAccountSampled(reading.Account):
			account := reading.Account
			entry.good = &account
		case reading.Account.State == "failed" || reading.Account.State == "throttled":
			reading.Account = runtime.CarryQuotaSample(reading.Account, entry.good, now)
		default:
			entry.good = nil
		}
		entry.reading, entry.sampled, entry.running = reading, now, nil
		c.mu.Unlock()
		close(running)
		return reading, nil
	}
}

// prefetchQuota reads every account once in the background when a phone
// establishes a session. The cache decides what is actually asked: an account
// read less than a minute ago, or one whose provider asked to be left alone,
// is not read again. This is the same batch a quota request makes, started
// before the reader opens the page, so the first view usually answers from
// the cache instead of waiting for the slowest provider.
func (e *Engine) prefetchQuota() {
	if !e.QuotaPrefetch || !e.quotaWarm.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer e.quotaWarm.Store(false)
		e.quotaReadings()
	}()
}

// rpcAgentQuota answers the first quota operation: the six providers it
// defined, in its item shape, from the read AgentQuotaV2 shares.
func (e *Engine) rpcAgentQuota(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "AgentQuota takes no parameters")
		return
	}
	readings, err := e.quotaBatch(nil)
	if err != nil {
		e.replyErr(s, id, "internal", "subscription quota query timed out")
		return
	}
	items := []runtime.AgentQuota{}
	for _, reading := range readings {
		if reading.Legacy != nil {
			items = append(items, *reading.Legacy)
		}
	}
	e.reply(s, id, map[string]any{"items": items})
}

func (e *Engine) rpcAgentQuotaV2(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "AgentQuotaV2 takes no parameters")
		return
	}
	readings, err := e.quotaBatch(nil)
	if err != nil {
		e.replyErr(s, id, "internal", "subscription quota query timed out")
		return
	}
	items := make([]runtime.QuotaAccount, len(readings))
	for i, reading := range readings {
		items[i] = reading.Account
	}
	e.reply(s, id, map[string]any{"items": items})
}
