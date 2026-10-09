package journal

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Agent CLIs persist harness-injected context in the same user records as real
// prompts. The filters below keep the chat view to what a person typed and the
// agent said; the transcript on disk is never modified.

// Codex injects AGENTS.md, environment and turn bookkeeping as user input.
var codexInjectedTags = []string{
	"environment_context", "user_instructions", "developer_instructions", "INSTRUCTIONS",
	"turn_aborted", "subagent_notification", "skill", "codex_internal_context",
}

// Codex 0.162 writes these empty image references ahead of the user's request.
// Match only its generated wrapper; ordinary user markup remains visible.
var codexImageReference = regexp.MustCompile(`^<image name=\[Image #[0-9]+\] path="[^"\r\n]+">\s*</image>\s*`)

// In the transcript the same wrapper is three content items: the opening
// reference, the image itself, then the closing tag on its own.
var codexImageOpen = regexp.MustCompile(`^<image name=\[Image #[0-9]+\] path="[^"\r\n]+">$`)

// codexImageWrapper follows one user message's content items and says which
// text items are that wrapper. A closing tag counts only after its opening
// reference, so the same text typed by the user stays visible.
type codexImageWrapper struct{ open bool }

func (w *codexImageWrapper) drops(text string) bool {
	trimmed := strings.TrimSpace(text)
	if codexImageOpen.MatchString(trimmed) {
		w.open = true
		return true
	}
	if w.open && trimmed == "</image>" {
		w.open = false
		return true
	}
	return false
}

// Claude Code wraps local command output, reminders, hook output and
// background notifications in these tags inside ordinary user records.
var claudeInjectedTags = []string{
	"system-reminder", "local-command-caveat", "local-command-stdout", "local-command-stderr",
	"task-notification", "bash-stdout", "bash-stderr", "user-prompt-submit-hook",
}

// claudeRecordFlags marks Claude Code records that never reach the chat as
// typed: meta records (caveats, skill bodies, image notes), sidechains,
// compaction summaries and transcript-only notes.
type claudeRecordFlags struct {
	IsMeta                    bool `json:"isMeta"`
	IsSidechain               bool `json:"isSidechain"`
	IsCompactSummary          bool `json:"isCompactSummary"`
	IsVisibleInTranscriptOnly bool `json:"isVisibleInTranscriptOnly"`
	IsAPIErrorMessage         bool `json:"isApiErrorMessage"`
}

func (f claudeRecordFlags) hidden() bool {
	return f.IsMeta || f.IsSidechain || f.IsCompactSummary || f.IsVisibleInTranscriptOnly
}

// claudeSyntheticModel labels placeholder assistant records such as
// "No response requested." that Claude Code writes without a model call.
const claudeSyntheticModel = "<synthetic>"

// syntheticPlaceholder reports a synthetic record to drop. Claude Code also
// writes API errors and rate-limit notices as synthetic assistant records;
// those explain why a turn stopped, so they stay visible.
func (f claudeRecordFlags) syntheticPlaceholder(model string) bool {
	return model == claudeSyntheticModel && !f.IsAPIErrorMessage
}

// visibleCodexUserText drops the context Codex submits as user input. Codex
// sends each injection as its own leading block (an AGENTS.md heading, then
// tagged blocks), so only leading blocks are stripped; the same tags later in
// a prompt are the user's own text.
func visibleCodexUserText(text string) string {
	if body, ok := leadingTaggedBody(text, "send_user_message_question_reply"); ok {
		return codexQuestionAnswers(body)
	}
	rest := text
	for {
		rest = strings.TrimLeft(rest, " \t\r\n")
		if loc := codexImageReference.FindStringIndex(rest); loc != nil {
			rest = rest[loc[1]:]
			continue
		}
		if strings.HasPrefix(rest, "# AGENTS.md instructions") {
			_, after, _ := strings.Cut(rest, "\n")
			rest = after
			continue
		}
		next, ok := withoutLeadingBlock(rest, codexInjectedTags)
		if !ok {
			break
		}
		rest = next
	}
	return strings.TrimSpace(rest)
}

// codexQuestionAnswers shows what the user picked or typed for a Codex
// question tool, without the question echo and internal item IDs.
func codexQuestionAnswers(body string) string {
	var replies []struct {
		Answer string `json:"answer"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(body)), &replies) != nil {
		return strings.TrimSpace(body)
	}
	answers := make([]string, 0, len(replies))
	for _, reply := range replies {
		if answer := strings.TrimSpace(reply.Answer); answer != "" {
			answers = append(answers, answer)
		}
	}
	return strings.Join(answers, "\n")
}

// claudeUserEvent classifies one Claude Code user text as a typed prompt, a
// slash or shell command in its typed form, or the interrupt notice Claude
// Code records in place of a prompt. ok is false when nothing user-facing
// remains after injected context is dropped.
func claudeUserEvent(text string) (Event, bool) {
	// Claude Code writes a command as a record made only of these tags; the
	// same tags inside a typed prompt are the user's text.
	if startsWithTag(text, "command-name", "command-message", "command-args") {
		name, _ := taggedBody(text, "command-name")
		if name = strings.TrimSpace(name); name == "" {
			return Event{}, false
		}
		if !strings.HasPrefix(name, "/") {
			name = "/" + name
		}
		args, _ := taggedBody(text, "command-args")
		return Event{Type: EventCommand, Text: strings.TrimSpace(name + " " + strings.TrimSpace(args))}, true
	}
	if input, ok := leadingTaggedBody(text, "bash-input"); ok {
		if input = strings.TrimSpace(input); input == "" {
			return Event{}, false
		}
		return Event{Type: EventCommand, Text: "! " + input}, true
	}
	stripped := unwrapTagLines(stripTaggedBlocks(text, claudeInjectedTags), "pasted_content")
	if stripped != text {
		text = strings.TrimSpace(stripped)
	}
	switch strings.TrimSpace(text) {
	case "":
		return Event{}, false
	case "[Request interrupted by user]", "[Request interrupted by user for tool use]":
		return Event{Type: EventInterrupt}, true
	}
	return Event{Type: "user", Text: text}, true
}

// claudeShellEvents handles the records Claude Code writes for a "!" shell
// command: the typed command becomes a command item plus a Bash step, and the
// following stdout/stderr record becomes that step's output, so the result is
// readable instead of dropped with the other injected text.
func claudeShellEvents(text string) ([]parsedEvent, bool) {
	if input, ok := leadingTaggedBody(text, "bash-input"); ok {
		if input = strings.TrimSpace(input); input == "" {
			return nil, true
		}
		arguments, _ := json.Marshal(map[string]string{"command": input})
		return []parsedEvent{
			{Event: Event{Type: EventCommand, Text: "! " + input}},
			{Event: Event{Type: "tool", Name: "Bash", Input: string(arguments)}, call: claudeShellCall},
		}, true
	}
	if !startsWithTag(text, "bash-stdout", "bash-stderr") {
		return nil, false
	}
	// Claude Code writes both streams on one line: <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>.
	stdout := inlineTagBody(text, "bash-stdout")
	stderr := inlineTagBody(text, "bash-stderr")
	output := strings.TrimSpace(strings.Join([]string{strings.TrimSpace(stdout), strings.TrimSpace(stderr)}, "\n"))
	state := "done"
	if strings.TrimSpace(stdout) == "" && strings.TrimSpace(stderr) != "" {
		state = "error"
	}
	if output == "" {
		output = "(no output)"
	}
	return []parsedEvent{{Event: Event{Type: "tool", Output: output, State: state}, call: claudeShellCall, outputOnly: true}}, true
}

// claudeShellCall pairs a "!" command's output with its own step. Agent tools
// always carry their own ids, so the output never lands on one of them; with
// the command on an older page the output is simply dropped.
const claudeShellCall = "claude-shell"

func inlineTagBody(text, tag string) string {
	_, rest, ok := strings.Cut(text, "<"+tag+">")
	if !ok {
		return ""
	}
	body, _, _ := strings.Cut(rest, "</"+tag+">")
	return body
}

// visibleClaudeUserText is the History form: commands read as typed text and
// interrupt notices are dropped.
func visibleClaudeUserText(text string) string {
	event, ok := claudeUserEvent(text)
	if !ok || event.Type == EventInterrupt {
		return ""
	}
	return event.Text
}

// visibleGrokUserText drops prompts Grok marks hideFromScrollback (background
// task notices it submits for itself) and reminders inside typed prompts.
func visibleGrokUserText(text string, meta json.RawMessage) string {
	var flags struct {
		HideFromScrollback bool `json:"hideFromScrollback"`
	}
	if json.Unmarshal(meta, &flags) == nil && flags.HideFromScrollback {
		return ""
	}
	return withoutSystemReminders(text)
}

// visibleClaudeToolOutput removes reminders Claude Code appends to tool
// results. A result that is only a reminder (Read on an empty file) keeps the
// reminder's words so the tool still completes.
func visibleClaudeToolOutput(output string) string {
	if stripped := withoutSystemReminders(output); stripped != "" {
		return stripped
	}
	body, _ := taggedBody(output, "system-reminder")
	return strings.TrimSpace(body)
}

// withoutSystemReminders removes reminders agents append to tool results and
// prompts.
func withoutSystemReminders(output string) string {
	stripped := stripTaggedBlocks(output, []string{"system-reminder"})
	if stripped == output {
		return output
	}
	return strings.TrimSpace(stripped)
}

// stripTaggedBlocks removes complete <tag>…</tag> blocks that open at the start
// of a line. An unterminated block is left visible rather than dropping the
// rest of a message that may be the user's own text.
func stripTaggedBlocks(text string, tags []string) string {
	for _, tag := range tags {
		closing := "</" + tag + ">"
		for from := 0; from <= len(text); {
			start := tagOpenAtLineStart(text, "<"+tag, from)
			if start < 0 {
				break
			}
			end := strings.Index(text[start:], closing)
			if end < 0 {
				break
			}
			text = text[:start] + text[start+end+len(closing):]
			from = start
		}
	}
	return text
}

// unwrapTagLines keeps the body of a wrapper such as pasted text but drops
// lines that hold only its opening or closing tag.
func unwrapTagLines(text, tag string) string {
	if !strings.Contains(text, "<"+tag) {
		return text
	}
	lines := strings.Split(text, "\n")
	kept := lines[:0]
	for _, line := range lines {
		s := strings.TrimSpace(line)
		if strings.HasSuffix(s, ">") && (tagOpenAtLineStart(s, "<"+tag, 0) == 0 || tagOpenAtLineStart(s, "</"+tag, 0) == 0) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func startsWithTag(text string, tags ...string) bool {
	text = strings.TrimLeft(text, " \t\r\n")
	for _, tag := range tags {
		if tagOpenAtLineStart(text, "<"+tag, 0) == 0 {
			return true
		}
	}
	return false
}

// leadingTaggedBody is taggedBody for a block that opens the text.
func leadingTaggedBody(text, tag string) (string, bool) {
	if !startsWithTag(text, tag) {
		return "", false
	}
	return taggedBody(text, tag)
}

// withoutLeadingBlock removes one complete block, of any of tags, that opens
// the text.
func withoutLeadingBlock(text string, tags []string) (string, bool) {
	for _, tag := range tags {
		if !startsWithTag(text, tag) {
			continue
		}
		end := strings.Index(text, "</"+tag+">")
		if end < 0 {
			return text, false
		}
		return text[end+len("</"+tag+">"):], true
	}
	return text, false
}

// taggedBody returns the body of the first <tag>…</tag> block opening at the
// start of a line.
func taggedBody(text, tag string) (string, bool) {
	start := tagOpenAtLineStart(text, "<"+tag, 0)
	if start < 0 {
		return "", false
	}
	bodyStart := strings.IndexByte(text[start:], '>')
	if bodyStart < 0 {
		return "", false
	}
	body := text[start+bodyStart+1:]
	end := strings.Index(body, "</"+tag+">")
	if end < 0 {
		return "", false
	}
	return body[:end], true
}

func tagOpenAtLineStart(text, open string, from int) int {
	for from <= len(text) {
		i := strings.Index(text[from:], open)
		if i < 0 {
			return -1
		}
		i += from
		from = i + len(open)
		if from < len(text) && text[from] != '>' && text[from] != ' ' {
			continue
		}
		lineStart := strings.LastIndexByte(text[:i], '\n') + 1
		if strings.TrimLeft(text[lineStart:i], " \t") == "" {
			return i
		}
	}
	return -1
}
