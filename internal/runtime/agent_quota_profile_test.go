package runtime

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"
)

// Opt-in local-account timing. Never log account contents, credentials or paths.
func TestQuotaProviderProfile(t *testing.T) {
	if os.Getenv("PAIRFOB_PROFILE_QUOTA") != "1" {
		t.Skip("explicit local account timing only")
	}
	selected, err := QuotaSelection()
	if err != nil {
		t.Fatal(err)
	}
	enabled := map[string]bool{}
	for _, id := range selected {
		enabled[id] = true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	start := time.Now()
	var wg sync.WaitGroup
	report := func(id, state string, began, located time.Time) {
		data, _ := json.Marshal(map[string]any{
			"provider": id, "state": state,
			"locate_ms": float64(located.Sub(began).Microseconds()) / 1000,
			"read_ms":   float64(time.Since(located).Microseconds()) / 1000,
			"total_ms":  float64(time.Since(began).Microseconds()) / 1000,
		})
		t.Log(string(data))
	}
	for _, p := range quotaProviders {
		if !enabled[p.name] {
			continue
		}
		wg.Go(func() {
			ctx := context.WithValue(ctx, quotaNoteKey{}, &quotaNote{})
			began := time.Now()
			read, q := p.locate(ctx)
			located := time.Now()
			if read != nil {
				q = p.ask(ctx, read)
			}
			report(p.name, q.Status, began, located)
		})
	}
	for _, p := range quotaAccountProviders {
		if !enabled[p.name] {
			continue
		}
		wg.Go(func() {
			ctx := context.WithValue(ctx, quotaNoteKey{}, &quotaNote{})
			began := time.Now()
			read, q := p.locate(ctx)
			located := time.Now()
			state := q.Status
			if read != nil {
				state = read(ctx).State
			}
			report(p.name, state, began, located)
		})
	}
	wg.Wait()
	t.Logf("batch_ms=%.3f", float64(time.Since(start).Microseconds())/1000)
}
