package daemon

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// codexChoiceDialog reports whether the bottom of a Codex pane is a live
// numbered choice, the shape parseTerminalDialog accepts in the PWA. Herdr
// misses some of these (the plan picker included) and reports idle or done.
// Only the recognition needed to lift that status is ported: one selected
// option, options numbered from 1, and nothing but blanks, rules, or key
// hints under the list.
const maxDialogHintLines = 3

var (
	dialogScrollbar = regexp.MustCompile(`(?:^|\s+)[█▐▌▕▏▊▋▍▎]$`)
	dialogBorderL   = regexp.MustCompile(`^\s*[│┃|]\s?`)
	dialogBorderR   = regexp.MustCompile(`\s*[│┃|]\s*$`)
	dialogRule      = regexp.MustCompile(`^[\s─━═╭╮╰╯┌┐└┘-]*$`)
	dialogOption    = regexp.MustCompile(`^(?:([❯›>▸▶])\s*)?(\d{1,2})[.)]\s+(\S.*)$`)
	dialogHint      = regexp.MustCompile(`(?i)(?:\b(?:esc|enter|cancel|confirm|navigate|select|tab)\b|[↑↓])`)
	dialogWrap      = regexp.MustCompile(`^\s{2,}\S`)
)

type dialogChoice struct {
	number   int
	selected bool
}

func codexChoiceDialog(text string) bool {
	lines := dialogLines(text)
	end := bottomDialogOption(lines)
	if end < 0 {
		return false
	}
	var found []dialogChoice
	for index := end; index >= 0; index-- {
		trimmed := strings.TrimSpace(lines[index])
		if choice, ok := parseDialogChoice(trimmed); ok {
			found = append([]dialogChoice{choice}, found...)
			if choice.number == 1 {
				break
			}
			continue
		}
		if trimmed == "" || dialogRule.MatchString(trimmed) || dialogWrap.MatchString(lines[index]) {
			continue
		}
		return false
	}
	if len(found) < 2 || found[0].number != 1 {
		return false
	}
	selected := 0
	for i, choice := range found {
		if choice.number != i+1 {
			return false
		}
		if choice.selected {
			selected++
		}
	}
	return selected == 1
}

func dialogLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	raw := strings.Split(text, "\n")
	lines := make([]string, len(raw))
	for i, line := range raw {
		lines[i] = dialogInner(line)
	}
	return lines
}

func dialogInner(line string) string {
	line = strings.TrimRightFunc(line, unicode.IsSpace)
	line = dialogScrollbar.ReplaceAllString(line, "")
	line = dialogBorderL.ReplaceAllString(line, "")
	line = dialogBorderR.ReplaceAllString(line, "")
	return strings.TrimRightFunc(line, unicode.IsSpace)
}

func parseDialogChoice(trimmed string) (dialogChoice, bool) {
	match := dialogOption.FindStringSubmatch(trimmed)
	if match == nil {
		return dialogChoice{}, false
	}
	number, err := strconv.Atoi(match[2])
	if err != nil {
		return dialogChoice{}, false
	}
	return dialogChoice{number: number, selected: match[1] != ""}, true
}

func bottomDialogOption(lines []string) int {
	hints := 0
	for index := len(lines) - 1; index >= 0; index-- {
		trimmed := strings.TrimSpace(lines[index])
		if _, ok := parseDialogChoice(trimmed); ok {
			return index
		}
		if trimmed == "" || dialogRule.MatchString(trimmed) {
			continue
		}
		hints++
		if !dialogHint.MatchString(trimmed) || hints > maxDialogHintLines {
			return -1
		}
	}
	return -1
}
