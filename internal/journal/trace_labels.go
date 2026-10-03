package journal

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Tool labels give a summary tool item a one-line hint of what the call did:
// its command, file, pattern or plan progress. Clients opt in with
// TraceOptions.Labels (GetConfig.capabilities.trace_labels); older clients
// reject unknown item keys. See proto/agent-trace-labels.md.

const maxTraceLabelRunes = 160

// Label sources in priority order. Each group names input keys whose string
// value becomes the label.
var (
	labelCommandKeys = []string{"command", "cmd", "script"}
	labelPathKeys    = []string{"file_path", "path", "file", "target_file", "filename", "notebook_path", "target_directory"}
	labelPatchKeys   = []string{"input", "patch"}
	labelQueryKeys   = []string{"pattern", "query", "regex", "q", "search"}
	labelURLKeys     = []string{"url", "uri"}
)

// toolLabel derives a label from a tool's input: compact JSON arguments, or
// raw text for Codex custom tools such as apply_patch. It returns "" when
// nothing useful can be derived.
func toolLabel(name, input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}
	var fields map[string]json.RawMessage
	if !strings.HasPrefix(trimmed, "{") || json.Unmarshal([]byte(trimmed), &fields) != nil {
		if name == "exec" {
			return labelText(codeModeLabel(input))
		}
		return labelText(patchLabel(input))
	}
	switch name {
	case "TodoWrite":
		if label := planLabel(fields["todos"]); label != "" {
			return label
		}
	case "update_plan":
		if label := planLabel(fields["plan"]); label != "" {
			return label
		}
	case "AskUserQuestion":
		if label := labelText(firstQuestion(fields["questions"], "question")); label != "" {
			return label
		}
	case "request_user_input_async", "request_user_input":
		if label := labelText(firstQuestion(fields["questions"], "title")); label != "" {
			return label
		}
	case "Skill":
		if label := labelText(firstString(fields, []string{"skill"})); label != "" {
			return label
		}
	case "Grep", "Glob", "grep", "glob", "search", "find", "rg":
		// A search reads by what it looks for; the path only scopes it.
		if label := labelText(firstString(fields, labelQueryKeys)); label != "" {
			return label
		}
	}
	for _, key := range labelCommandKeys {
		if label := labelText(commandLine(fields[key])); label != "" {
			return label
		}
	}
	if label := labelText(firstString(fields, labelPathKeys)); label != "" {
		return label
	}
	for _, key := range labelPatchKeys {
		if label := labelText(patchLabel(stringValue(fields[key]))); label != "" {
			return label
		}
	}
	for _, keys := range [][]string{labelQueryKeys, labelURLKeys, {"description"}} {
		if label := labelText(firstString(fields, keys)); label != "" {
			return label
		}
	}
	return ""
}

// planLabel counts completed plan steps as "<completed>/<total>".
func planLabel(raw json.RawMessage) string {
	var steps []struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(raw, &steps) != nil || len(steps) == 0 {
		return ""
	}
	completed := 0
	for _, step := range steps {
		if step.Status == "completed" {
			completed++
		}
	}
	return strconv.Itoa(completed) + "/" + strconv.Itoa(len(steps))
}

func firstQuestion(raw json.RawMessage, key string) string {
	var questions []map[string]json.RawMessage
	if json.Unmarshal(raw, &questions) != nil || len(questions) == 0 {
		return ""
	}
	return stringValue(questions[0][key])
}

// commandLine returns the first non-empty line of a command. An argv array
// (the old Codex shell tool sends ["bash", "-lc", "..."]) uses its last element.
func commandLine(raw json.RawMessage) string {
	command := stringValue(raw)
	if command == "" {
		var argv []string
		if json.Unmarshal(raw, &argv) != nil || len(argv) == 0 {
			return ""
		}
		command = argv[len(argv)-1]
	}
	for line := range strings.Lines(command) {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}

// patchLabel names the first file an apply_patch body touches, plus " +N" for
// the further files it touches.
func patchLabel(text string) string {
	first, more := "", 0
	for line := range strings.Lines(text) {
		line = strings.TrimSpace(line)
		for _, prefix := range []string{"*** Update File: ", "*** Add File: ", "*** Delete File: "} {
			file, ok := strings.CutPrefix(line, prefix)
			if !ok || strings.TrimSpace(file) == "" {
				continue
			}
			if first == "" {
				first = strings.TrimSpace(file)
			} else {
				more++
			}
		}
	}
	if first == "" || more == 0 {
		return first
	}
	return first + " +" + strconv.Itoa(more)
}

func firstString(fields map[string]json.RawMessage, keys []string) string {
	for _, key := range keys {
		if value := stringValue(fields[key]); strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func stringValue(raw json.RawMessage) string {
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

// labelText makes a value a label: one line without control or line-separator
// characters, at most maxTraceLabelRunes runes, clipped with "…".
func labelText(value string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToValidUTF8(value, "\uFFFD") {
		switch {
		case r == '\t' || r == '\n' || r == '\r' || r == '\u2028' || r == '\u2029':
			space = true
			continue
		case unicode.IsControl(r) || r == '\uFEFF':
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	label := b.String()
	if utf8.RuneCountInString(label) <= maxTraceLabelRunes {
		return label
	}
	runes := []rune(label)
	return strings.TrimRight(string(runes[:maxTraceLabelRunes-1]), " ") + "…"
}
