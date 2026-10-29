package runtime

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var openCodeVersionChecks sync.Map

type openCodeVersionCheck struct {
	size     int64
	modified time.Time
}

// The current Herdr integration requires pane-local TUI plugins. Older
// OpenCode releases can read history but cannot safely report shared servers.
func (h *Herdr) prepareOpenCodeObservation(ctx context.Context, session SessionRef) error {
	binary, err := exec.LookPath("opencode")
	if err != nil {
		return invalidFault("agent.start", "OpenCode is not installed")
	}
	info, err := os.Stat(binary)
	if err != nil {
		return err
	}
	stamp := openCodeVersionCheck{size: info.Size(), modified: info.ModTime()}
	cached, _ := openCodeVersionChecks.Load(binary)
	if cached != stamp {
		check, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		version, err := exec.CommandContext(check, binary, "--version").Output()
		if err != nil {
			return invalidFault("agent.start", "cannot read the installed OpenCode version")
		}
		if !supportsOpenCodeTUI(strings.TrimSpace(string(version))) {
			return invalidFault("agent.start", "OpenCode 1.18.29 or newer is required for session titles and pane-local progress; update OpenCode before creating this session")
		}
		openCodeVersionChecks.Store(binary, stamp)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		config = filepath.Join(home, ".config")
	}
	if err := os.MkdirAll(filepath.Join(config, "opencode"), 0700); err != nil {
		return err
	}
	_, err = h.call(ctx, session, "integration.install", map[string]any{"target": "opencode"}, true)
	return err
}

func supportsOpenCodeTUI(version string) bool {
	core, _, _ := strings.Cut(strings.TrimPrefix(version, "v"), "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	var numbers [3]int
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return false
		}
		numbers[i] = n
	}
	return numbers[0] >= 2 || (numbers[0] == 1 && (numbers[1] > 18 || (numbers[1] == 18 && numbers[2] >= 29)))
}
