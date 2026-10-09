package daemon

import (
	"maps"
	"path/filepath"
	"regexp"
	"strings"

	"pairfob/internal/runtime"
)

// tokens.task is existing display metadata. Keep the raw OSC and user label
// intact; all phone surfaces can share this derived name without a new RPC field.
func (e *Engine) decorateAgentTitle(pane *runtime.Pane) {
	if pane.Agent != "codex" || pane.AgentSession == nil || e.Journal == nil {
		return
	}
	title := e.Journal.ReadTitle(journalRef(pane.AgentSession))
	name := title.Name
	if name == "" {
		name = codexTerminalTask(pane.TerminalTitle, pane.Cwd)
	}
	if name == "" {
		name = title.Prompt
	}
	if name == "" || pane.Tokens["task"] != "" {
		return
	}
	pane.Tokens = maps.Clone(pane.Tokens)
	if pane.Tokens == nil {
		pane.Tokens = make(map[string]string)
	}
	pane.Tokens["task"] = name
}

var codexTitleActivity = regexp.MustCompile(`^(?:[●*]\s+)?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-](?:\s+|$)`)
var codexTitleProgress = regexp.MustCompile(`\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$`)
var codexTitleStatus = regexp.MustCompile(`(?i)^(?:\[\s*[!.]\s*\]\s*Action Required|Starting|Ready|Working|Thinking|Waiting)$`)

func codexTerminalTask(raw, cwd string) string {
	parts := strings.Split(strings.TrimSpace(raw), " | ")
	parts[0] = strings.TrimSpace(codexTitleActivity.ReplaceAllString(parts[0], ""))
	if codexTitleStatus.MatchString(parts[0]) {
		parts = parts[1:]
	}
	for len(parts) > 0 && strings.TrimSpace(parts[0]) == "" {
		parts = parts[1:]
	}
	if len(parts) > 1 && strings.EqualFold(strings.TrimSpace(parts[len(parts)-1]), filepath.Base(cwd)) {
		parts = parts[:len(parts)-1]
	}
	name := strings.TrimSpace(codexTitleProgress.ReplaceAllString(strings.Join(parts, " | "), ""))
	if name == "" || strings.EqualFold(name, "codex") || strings.EqualFold(name, filepath.Base(cwd)) ||
		name == cwd || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "~") || strings.Contains(name, "://") {
		return ""
	}
	return name
}

func observedTaskTitle(pane runtime.Pane) string {
	if title := pane.Tokens["task"]; title != "" {
		return title
	}
	if pane.Agent == "codex" {
		return codexTerminalTask(pane.TerminalTitle, pane.Cwd)
	}
	return ""
}
