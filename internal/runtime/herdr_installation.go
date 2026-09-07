package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

var errHerdrNotFound = errors.New("Herdr CLI was not found; install Herdr on this computer")

// HerdrInstallation is a local diagnosis, not an extension to the phone RPC.
type HerdrInstallation struct {
	State      string
	Descriptor Descriptor
	Cause      error
}

// CheckInstallation never launches a process or modifies the installation.
func (h *Herdr) CheckInstallation(ctx context.Context) HerdrInstallation {
	descriptor, err := h.bootstrapDescribe(ctx)
	if err == nil {
		if !descriptor.Supports(FeatureCreateConversation) {
			return HerdrInstallation{State: "incompatible", Descriptor: descriptor}
		}
		// The terminal bridge also needs the local CLI, even with a live server.
		if _, err := h.resolveBinary(); err != nil {
			return binaryInstallationFailure(err)
		}
		return HerdrInstallation{State: "ready", Descriptor: descriptor}
	}
	needsServer, socketErr := herdrSocketNeedsServer(h.Socket)
	if socketErr != nil || !needsServer {
		return HerdrInstallation{State: "unavailable", Cause: errors.Join(err, socketErr)}
	}
	if _, err := h.resolveBinary(); err != nil {
		return binaryInstallationFailure(err)
	}
	return HerdrInstallation{State: "stopped", Cause: err}
}

func binaryInstallationFailure(err error) HerdrInstallation {
	state := "unavailable"
	if errors.Is(err, errHerdrNotFound) {
		state = "missing"
	}
	return HerdrInstallation{State: state, Cause: err}
}

// ResolveHerdrBinary resolves the CLI used by the runtime so the user service
// can retain the same executable after its PATH changes at login.
func ResolveHerdrBinary() (string, error) { return resolveHerdrBinary("") }

func (h *Herdr) resolveBinary() (string, error) {
	if h.lookupBinary != nil {
		return h.lookupBinary(h.TerminalBinary)
	}
	return resolveHerdrBinary(h.TerminalBinary)
}

func resolveHerdrBinary(explicit string) (string, error) {
	if explicit != "" {
		return executableHerdr(explicit)
	}
	if env := os.Getenv("HERDR_BIN"); env != "" {
		return executableHerdr(env)
	}
	if found, err := exec.LookPath("herdr"); err == nil {
		return executableHerdr(found)
	}
	var candidates []string
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".local", "bin", "herdr"))
	}
	candidates = append(candidates, "/usr/local/bin/herdr", "/opt/homebrew/bin/herdr")
	return findHerdrCandidate(candidates)
}

func findHerdrCandidate(candidates []string) (string, error) {
	var invalid error
	for _, path := range candidates {
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			continue
		}
		binary, err := executableHerdr(path)
		if err == nil {
			return binary, nil
		}
		if invalid == nil {
			invalid = err
		}
	}
	// Preserve existing files/symlinks if no usable alternative exists. Installing
	// a new dependency must never silently replace an incomplete installation.
	if invalid != nil {
		return "", invalid
	}
	return "", &Fault{Code: CodeUnsupported, Operation: "terminal.open", Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: errHerdrNotFound.Error(), Cause: errHerdrNotFound}
}

func executableHerdr(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("inspect Herdr executable %s: %w", path, err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return "", fmt.Errorf("Herdr path is not an executable file: %s", path)
	}
	return filepath.Abs(path)
}
