package daemon

import (
	"context"
	"time"
)

type runtimePoke struct{ reason, paneID string }

// Only duplicate invalidations are folded. Distinct panes still wake their own
// reads, availability changes bypass batching, and notifications use another lane.
const runtimePokeWindow = 20 * time.Millisecond

func runRuntimePokes(ctx context.Context, input <-chan runtimePoke, send func(string, string)) {
	for {
		var first runtimePoke
		select {
		case <-ctx.Done():
			return
		case first = <-input:
		}
		if first.reason != "agent_status" {
			send(first.reason, first.paneID)
			continue
		}
		batch := []runtimePoke{first}
		seen := map[runtimePoke]bool{first: true}
		timer := time.NewTimer(runtimePokeWindow)
	collect:
		for {
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				break collect
			case next := <-input:
				if next.reason != "agent_status" {
					send(next.reason, next.paneID)
					continue
				}
				if !seen[next] {
					seen[next] = true
					batch = append(batch, next)
				}
				if len(batch) >= 64 {
					break collect
				}
			}
		}
		timer.Stop()
		for _, event := range batch {
			send(event.reason, event.paneID)
		}
	}
}
