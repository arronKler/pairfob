package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"pairfob/internal/runtime"
)

type quotaCache struct {
	mu      sync.Mutex
	sampled time.Time
	items   []runtime.AgentQuota
}

func (e *Engine) rpcAgentQuota(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "AgentQuota takes no parameters")
		return
	}
	// One bounded account query across all phones; do not let refresh requests
	// accumulate processes or block terminal traffic on the session queue.
	if !e.quotas.mu.TryLock() {
		e.replyErr(s, id, "rate_limited", "quota refresh already running")
		return
	}
	defer e.quotas.mu.Unlock()
	if e.quotas.items == nil || time.Since(e.quotas.sampled) >= time.Minute {
		ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
		read := e.QuotaReader
		if read == nil {
			read = runtime.ReadAgentQuotas
		}
		e.quotas.items = read(ctx)
		cancel()
		e.quotas.sampled = time.Now()
	}
	e.reply(s, id, map[string]any{"items": e.quotas.items})
}
