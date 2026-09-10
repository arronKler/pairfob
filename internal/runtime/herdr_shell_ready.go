package runtime

import (
	"context"
	"encoding/json"
	"time"
)

// A newly spawned shell can still be running its startup scripts. Observe a
// settled foreground shell before the single agent.start mutation; Herdr still
// performs the authoritative availability check when it handles that call.
func (h *Herdr) waitCreatedShell(ctx context.Context, session SessionRef, paneID string) error {
	return h.waitCreatedShellWithin(ctx, session, paneID, 5*time.Second, 100*time.Millisecond, 300*time.Millisecond)
}

func (h *Herdr) waitCreatedShellWithin(ctx context.Context, session SessionRef, paneID string, timeout, poll, settle time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var readySince time.Time
	var readyPID uint32
	for ctx.Err() == nil {
		raw, err := h.call(ctx, session, "pane.process_info", map[string]any{"pane_id": paneID}, false)
		if err != nil {
			if ctx.Err() != nil || contextDeadlineReached(ctx) {
				break
			}
			return err
		}
		var wire struct {
			Type string `json:"type"`
			Info struct {
				PaneID     string  `json:"pane_id"`
				ShellPID   *uint32 `json:"shell_pid"`
				Foreground *uint32 `json:"foreground_process_group_id"`
				Processes  []struct {
					PID uint32 `json:"pid"`
				} `json:"foreground_processes"`
			} `json:"process_info"`
		}
		if json.Unmarshal(raw, &wire) != nil || wire.Type != "pane_process_info" || wire.Info.PaneID != paneID {
			return responseFault("pane.process_info", "invalid Herdr shell process response", nil, false)
		}
		info := wire.Info
		ready := info.ShellPID != nil && *info.ShellPID != 0 && info.Foreground != nil &&
			*info.Foreground == *info.ShellPID && len(info.Processes) == 1 && info.Processes[0].PID == *info.ShellPID
		if !ready {
			readySince = time.Time{}
		} else if readySince.IsZero() || readyPID != *info.ShellPID {
			readyPID = *info.ShellPID
			readySince = time.Now()
		} else if time.Since(readySince) >= settle {
			return nil
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return &Fault{Code: CodeNotReady, Operation: "agent.start", Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: "new shell did not become ready for agent startup"}
}

// The readiness window is this context's deadline. The socket deadline Herdr's
// call path derives from the same instant can report an i/o timeout a hair
// before the context timer advances ctx.Err(); once the window has actually
// elapsed that is our own "never became ready" outcome, not an unrelated
// transport fault. Errors that arrive before the deadline stay fail-closed as
// their original (transport/unsupported/…) fault code.
func contextDeadlineReached(ctx context.Context) bool {
	deadline, ok := ctx.Deadline()
	return ok && !time.Now().Before(deadline)
}
