package daemon

import (
	"context"
	"os"
	"testing"
	"time"

	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

// Reads the live runtime and trusted journals only; never issues a mutation.
func TestConnectionProfileLive(t *testing.T) {
	if os.Getenv("PAIRFOB_PROFILE_LIVE") != "1" {
		t.Skip("set PAIRFOB_PROFILE_LIVE=1 for read-only live profiling")
	}
	h := runtime.NewHerdr(runtime.DefaultSocket())
	e := &Engine{Journal: journal.NewDefault()}
	for sample := 0; sample < 3; sample++ {
		if sample > 0 {
			time.Sleep(2100 * time.Millisecond) // Cross the display-title refresh window.
		}
		started := time.Now()
		totalStarted := started
		view, err := h.Observe(context.Background(), runtime.SessionRef{}, runtime.SnapshotQuery{})
		if err != nil {
			t.Fatal(err)
		}
		snapshot := view.(runtime.SnapshotView).Snapshot
		t.Logf("sample=%d stage=runtime duration=%s panes=%d", sample, time.Since(started), len(snapshot.Panes))
		totals := map[string]time.Duration{}
		for i := range snapshot.Panes {
			pane := &snapshot.Panes[i]
			started = time.Now()
			e.decorateAgentTitle(pane)
			totals["title"] += time.Since(started)
			started = time.Now()
			if pane.Agent != "" && pane.AgentStatus != "unknown" && pane.AgentStatus != "blocked" {
				e.decorateTaskStatus(pane)
			}
			totals["status"] += time.Since(started)
			started = time.Now()
			e.decorateTurnActivity(pane)
			totals["activity"] += time.Since(started)
			started = time.Now()
			if pane.AgentSession != nil {
				e.Journal.Available(journalRef(pane.AgentSession))
			}
			totals["available"] += time.Since(started)
		}
		t.Logf("sample=%d stage=total duration=%s", sample, time.Since(totalStarted))
		for _, stage := range []string{"title", "status", "activity", "available"} {
			t.Logf("sample=%d stage=%s duration=%s", sample, stage, totals[stage])
		}
	}
}
