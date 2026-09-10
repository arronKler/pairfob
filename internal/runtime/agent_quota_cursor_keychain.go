package runtime

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

const cursorQuotaTokenLimit = 16384

// Match Cursor CLI's macOS credential reader: security has its own Keychain
// authorization, which can differ from osascript's. Read only the selected
// account; never refresh credentials or fall back to another store. macOS may
// request access; the daemon stops waiting for authorization at the deadline.
func cursorQuotaKeychain(ctx context.Context) (string, string) {
	return runCursorQuotaKeychain(ctx, "/usr/bin/security", "find-generic-password", "-a", "cursor-user", "-s", "cursor-access-token", "-w")
}

func runCursorQuotaKeychain(parent context.Context, name string, args ...string) (string, string) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 200 * time.Millisecond
	// security -w adds a newline. Discard stderr; it may contain credential data.
	out := &quotaOutput{limit: cursorQuotaTokenLimit + 1}
	cmd.Stdout = out
	err := cmd.Run()
	if err != nil {
		var exit *exec.ExitError
		if ctx.Err() == nil && errors.As(err, &exit) && exit.ExitCode() == 44 {
			return "", "not_logged_in"
		}
		return "", "auth_required"
	}
	token := strings.TrimSpace(out.String())
	if token == "" || len(token) > cursorQuotaTokenLimit {
		return "", "auth_required"
	}
	return token, ""
}
