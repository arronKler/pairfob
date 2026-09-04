package daemon

import (
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	oscSpinner = regexp.MustCompile(`^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]\s*`)
	oscStatus  = regexp.MustCompile(`(?i)^(?:[-–—•]\s*)?(?:Thinking|Waiting for response|Waiting|Working|Running)[.…]*\s*(?:[-–—]\s*)?`)
	userAtHost = regexp.MustCompile(`^[^@\s]+@\S+`)
)

var machineTitles = map[string]struct{}{
	"zsh": {}, "bash": {}, "sh": {}, "fish": {}, "nu": {}, "csh": {}, "tcsh": {},
	"node": {}, "nodejs": {}, "vim": {}, "nvim": {}, "emacs": {}, "nano": {},
	"tmux": {}, "screen": {}, "python": {}, "python3": {}, "ruby": {}, "perl": {},
	"ssh": {}, "login": {}, "shell": {}, "terminal": {}, "term": {},
}

var hiddenTabLabels = map[string]struct{}{
	"main": {}, "tab": {}, "new tab": {}, "unnamed tab": {}, "未命名标签页": {},
}

func compactPushText(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	return strings.Join(strings.Fields(value), " ")
}

func optionalText(value *string) string {
	if value == nil {
		return ""
	}
	return compactPushText(*value)
}

func sameFold(left, right string) bool {
	left = compactPushText(left)
	right = compactPushText(right)
	return left != "" && strings.EqualFold(left, right)
}

func cwdBase(cwd string) string {
	base := filepath.Base(strings.TrimSpace(cwd))
	if base == "." || base == string(filepath.Separator) || base == "" {
		return ""
	}
	return compactPushText(base)
}

func visiblePushTabLabel(label string) string {
	text := compactPushText(label)
	if text == "" {
		return ""
	}
	if _, hidden := hiddenTabLabels[strings.ToLower(text)]; hidden {
		return ""
	}
	return text
}

func stripTrailingAgent(text, agent string) string {
	agent = compactPushText(agent)
	if agent == "" {
		return strings.TrimSpace(text)
	}
	for {
		trimmed := strings.TrimSpace(text)
		cut := false
		for _, sep := range []string{" - ", " – ", " — "} {
			suffix := sep + agent
			if len(trimmed) > len(suffix) && strings.EqualFold(trimmed[len(trimmed)-len(suffix):], suffix) {
				text = trimmed[:len(trimmed)-len(suffix)]
				cut = true
				break
			}
		}
		if !cut {
			return trimmed
		}
	}
}

func cleanOscTitle(text, agent string) string {
	named := strings.TrimSpace(oscSpinner.ReplaceAllString(compactPushText(text), ""))
	for oscStatus.MatchString(named) {
		named = strings.TrimSpace(oscStatus.ReplaceAllString(named, ""))
	}
	named = strings.TrimLeft(named, "-–— \t")
	return stripTrailingAgent(named, agent)
}

func looksLikeMachineTitle(text string, event HerdPush) bool {
	trimmed := compactPushText(text)
	if trimmed == "" {
		return true
	}
	lower := strings.ToLower(trimmed)
	if _, ok := machineTitles[lower]; ok {
		return true
	}
	if event.Agent != "" && sameFold(trimmed, event.Agent) {
		return true
	}
	switch lower {
	case "终端", "会话", "未命名会话", "session", "unnamed session":
		return true
	}
	if strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "~") || strings.Contains(trimmed, "://") {
		return true
	}
	if utf8.RuneCountInString(trimmed) >= 3 {
		runes := []rune(trimmed)
		if unicode.IsLetter(runes[0]) && runes[1] == ':' && (runes[2] == '\\' || runes[2] == '/') {
			return true
		}
	}
	if userAtHost.MatchString(trimmed) {
		return true
	}
	if strings.Contains(trimmed, "/") && !strings.ContainsAny(trimmed, " \t") && strings.Count(trimmed, "/") >= 1 {
		return true
	}
	if event.Cwd != "" && sameFold(trimmed, event.Cwd) {
		return true
	}
	if sameFold(trimmed, cwdBase(event.Cwd)) || sameFold(trimmed, event.WorkspaceLabel) {
		return true
	}
	return false
}

func pushSubject(event HerdPush) string {
	for _, raw := range []string{event.PaneLabel, event.TerminalTitle, visiblePushTabLabel(event.TabLabel)} {
		cleaned := cleanOscTitle(raw, event.Agent)
		if cleaned != "" && !looksLikeMachineTitle(cleaned, event) {
			return cleaned
		}
	}
	return ""
}

func pushPlace(event HerdPush) string {
	workspace := compactPushText(event.WorkspaceLabel)
	dir := cwdBase(event.Cwd)
	switch {
	case workspace != "" && dir != "" && sameFold(workspace, dir):
		return workspace
	case workspace != "" && dir != "":
		return workspace + " · " + dir
	case workspace != "":
		return workspace
	case dir != "":
		return dir
	default:
		return "Workspace"
	}
}

func copyAlreadyShown(value, title string, bits []string) bool {
	if value == "" {
		return true
	}
	for _, bit := range bits {
		if sameFold(bit, value) {
			return true
		}
	}
	if sameFold(title, value) {
		return true
	}
	for _, part := range strings.Split(title, " · ") {
		if sameFold(strings.TrimSpace(part), value) {
			return true
		}
	}
	return false
}

func pushNotificationCopy(event HerdPush) (title, body string) {
	agent := compactPushText(event.Agent)
	if agent == "" {
		agent = "Agent"
	}
	status := "等待确认"
	if event.Kind == PushDone {
		status = "任务已完成"
	}
	// Keep the product and state in the trusted title. Pane and terminal labels
	// are useful context, but belong in the body because they are user-controlled.
	title = "Pairfob · " + status
	subject := pushSubject(event)
	place := pushPlace(event)
	bits := []string{agent}
	if !copyAlreadyShown(subject, title, bits) {
		bits = append(bits, subject)
	}
	if !copyAlreadyShown(place, title, bits) {
		bits = append(bits, place)
	}
	body, _ = truncateUTF8(strings.Join(bits, " · "), 160)
	return title, body
}
