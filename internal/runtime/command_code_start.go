package runtime

import (
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
)

func commandCodeBinary() string {
	for _, name := range []string{"command-code", "commandcode"} {
		if path, err := exec.LookPath(name); err == nil && filepath.IsAbs(path) {
			return path
		}
	}
	return ""
}

// Command Code reports itself as custom:cmd. It has no Herdr agent.start
// manifest, so launch its fixed local executable once into a settled shell.
func (h *Herdr) startCommandCode(ctx context.Context, session SessionRef, paneID, name string) (string, error) {
	binary := commandCodeBinary()
	if binary == "" {
		return "", unsupported("agent.start", "Command Code is not installed")
	}
	if err := h.waitCreatedShell(ctx, session, paneID); err != nil {
		return "", err
	}
	raw, err := h.call(ctx, session, "pane.send_input", map[string]any{"pane_id": paneID, "text": shellQuoteHook(binary), "keys": []string{"enter"}}, true)
	if err != nil {
		return "", err
	}
	var response struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Type != "ok" {
		return "", responseFault("pane.send_input", "invalid Command Code launch response", nil, true)
	}
	// Command Code binds its harness lazily, on the first submitted turn.
	// Queue admission is confirmed; a native agent identity does not exist yet.
	return "", nil
}
