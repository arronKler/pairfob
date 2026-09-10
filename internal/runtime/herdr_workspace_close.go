package runtime

import (
	"context"
	"regexp"
	"strconv"
)

var stableHerdrVersion = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z.-]+)?$`)

// Herdr 0.9.0 introduced an atomic rejection of implicit worktree-group closes.
// Earlier versions silently ignore close_group=false. Snapshot membership alone
// cannot protect against a group changing between the read and the mutation.
// Gate at the wire boundary so failed-creation compensation is protected too.
func (h *Herdr) requireSingleWorkspaceClose(ctx context.Context, session SessionRef) error {
	snapshot, err := h.snapshot(ctx, session)
	if err != nil {
		return err
	}
	if !supportsSingleWorkspaceClose(snapshot.HerdrVersion) {
		return unsupported("workspace.close", "safe workspace close requires Herdr 0.9.0 or newer; no workspace was closed")
	}
	return nil
}

func supportsSingleWorkspaceClose(version string) bool {
	parts := stableHerdrVersion.FindStringSubmatch(version)
	if parts == nil {
		return false
	}
	major, errMajor := strconv.ParseUint(parts[1], 10, 32)
	minor, errMinor := strconv.ParseUint(parts[2], 10, 32)
	_, errPatch := strconv.ParseUint(parts[3], 10, 32)
	return errMajor == nil && errMinor == nil && errPatch == nil && (major > 0 || minor >= 9)
}
