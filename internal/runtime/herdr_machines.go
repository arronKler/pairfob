package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const machineListTimeout = 5 * time.Second

var validMachineID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// Saved machines live in the Herdr client catalog, not behind the server
// socket, so the CLI is the only reader.
func (h *Herdr) listMachines(ctx context.Context) (View, error) {
	binary, err := h.resolveBinary()
	if err != nil {
		return nil, unsupported("machines", "Herdr CLI is not available")
	}
	ctx, cancel := context.WithTimeout(ctx, machineListTimeout)
	defer cancel()
	run := h.runCLI
	if run == nil {
		run = runHerdrCLI
	}
	out, err := run(ctx, binary, "machine", "list", "--json")
	if err != nil {
		if ctx.Err() != nil {
			return nil, contextFault("machines", ctx.Err(), false)
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, unsupported("machines", "this Herdr does not list saved machines")
		}
		return nil, &Fault{Code: CodeOffline, Operation: "machines", Outcome: OutcomeNotApplied, Retry: RetryReadSafe, SafeMessage: "Herdr CLI could not run", Cause: err}
	}
	var rows []struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		Target  string `json:"target"`
		Session string `json:"session"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return nil, &Fault{Code: CodeInternal, Operation: "machines", Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: "Herdr returned an unreadable machine list", Cause: err}
	}
	machines := make([]Machine, 0, len(rows))
	for _, row := range rows {
		if !validMachineID.MatchString(row.ID) || !validMachineTarget(row.Target) {
			continue
		}
		machines = append(machines, Machine{ID: row.ID, Label: row.Label, Target: row.Target, Session: row.Session, Enabled: row.Enabled})
	}
	return MachineListView{Machines: machines}, nil
}

// A target becomes one ssh argument. Anything that could be read as an option
// or split by a shell is dropped rather than repaired.
func validMachineTarget(target string) bool {
	if target == "" || len(target) > 512 || strings.HasPrefix(target, "-") {
		return false
	}
	for _, r := range target {
		if r <= ' ' || r == 0x7f {
			return false
		}
	}
	return true
}

func runHerdrCLI(ctx context.Context, binary string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, binary, args...).Output()
}
