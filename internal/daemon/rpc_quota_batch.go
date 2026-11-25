package daemon

import (
	"context"
	"pairfob/internal/runtime"
	"time"
)

// Background warming may discard an expired batch; RPC callers report its error.
func (e *Engine) quotaReadings() []runtime.QuotaReading { return e.quotaReadingsProgress(nil) }
func (e *Engine) quotaReadingsProgress(progress func([]runtime.QuotaAccount)) []runtime.QuotaReading {
	readings, _ := e.quotaBatch(progress)
	return readings
}
func (e *Engine) quotaBatch(progress func([]runtime.QuotaAccount)) ([]runtime.QuotaReading, error) {
	ctx, cancel := context.WithTimeout(context.Background(), quotaBatchTime)
	defer cancel()
	return e.quotaBatchContext(ctx, progress)
}

// Each source keeps its own cached read. A departing waiter does not cancel
// another batch's owner, and workers can finish into the buffered channel.
func (e *Engine) quotaBatchContext(ctx context.Context, progress func([]runtime.QuotaAccount)) ([]runtime.QuotaReading, error) {
	sources := runtime.QuotaSources
	if e.QuotaSources != nil {
		sources = e.QuotaSources
	}
	list := sources()
	out := make([]runtime.QuotaReading, len(list))
	type completed struct {
		index   int
		reading runtime.QuotaReading
		err     error
	}
	ready := make(chan completed, len(list))
	for i, source := range list {
		go func() { reading, err := e.quotas.read(ctx, source); ready <- completed{i, reading, err} }()
	}
	batches := quotaProgress{send: progress}
	defer batches.stop()
	for remaining := len(list); remaining > 0; {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case result := <-ready:
			if result.err != nil {
				return nil, result.err
			}
			out[result.index] = result.reading
			remaining--
			batches.add(result.reading.Account)
		case <-batches.due:
			batches.flush()
		}
	}
	return out, nil
}

// Only pending useful results arm a timer: slow providers cause no periodic
// wakeups. The last interim frame is reserved for a sample if none was sent yet.
// Missing logins ride alongside useful data or the final response.
type quotaProgress struct {
	send    func([]runtime.QuotaAccount)
	timer   *time.Timer
	due     <-chan time.Time
	pending []runtime.QuotaAccount
	sent    int
	sampled bool
}

func (p *quotaProgress) add(account runtime.QuotaAccount) {
	if p.send == nil || p.sent == 4 {
		return
	}
	p.pending = append(p.pending, account)
	p.sampled = p.sampled || runtime.QuotaAccountSampled(account)
	if p.due == nil && (p.sampled || account.State != "not_configured") && (p.sent < 3 || p.sampled) {
		p.timer = time.NewTimer(40 * time.Millisecond)
		p.due = p.timer.C
	}
}
func (p *quotaProgress) flush() {
	p.due = nil
	p.send(p.pending)
	p.pending = nil
	p.sent++
}
func (p *quotaProgress) stop() {
	if p.timer != nil {
		p.timer.Stop()
	}
}
