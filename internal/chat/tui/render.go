package tui

import (
	"fmt"
	"strings"

	"pairfob/internal/chat/protocol"
)

// maxComposerLines keeps the input area from crowding out the transcript.
const maxComposerLines = 5

func (m *Model) renderHeader() string {
	state := m.state
	title := state.Title
	if title == "" {
		title = state.Agent
	}
	parts := make([]string, 0, 3)
	if title != "" {
		parts = append(parts, title)
	}
	parts = append(parts, state.Status)
	header := strings.Join(parts, " · ")
	if state.Usage != nil {
		header += fmt.Sprintf("  %d/%d tokens", state.Usage.Used, state.Usage.Size)
		if state.Usage.CostUSD > 0 {
			header += fmt.Sprintf("  $%.2f", state.Usage.CostUSD)
		}
	}
	return header
}

// renderTranscript draws every entry oldest first.
func renderTranscript(state *protocol.State) []string {
	if len(state.Entries) == 0 {
		return []string{"no messages yet"}
	}
	lines := make([]string, 0, len(state.Entries)*2)
	for _, entry := range state.Entries {
		lines = append(lines, renderEntry(entry)...)
	}
	return lines
}

func renderEntry(entry protocol.Entry) []string {
	switch entry.Kind {
	case protocol.KindTool:
		return renderTool(entry.Tool)
	case protocol.KindUser:
		return prefixLines("› ", entry.Text)
	case protocol.KindAgent:
		return prefixLines("● ", streamingText(entry))
	case protocol.KindThought:
		return prefixLines("… ", streamingText(entry))
	case protocol.KindNotice:
		return prefixLines("! ", entry.Text)
	default:
		return prefixLines("  ", entry.Text)
	}
}

func streamingText(entry protocol.Entry) string {
	if entry.Streaming {
		return entry.Text + "▌"
	}
	return entry.Text
}

func renderTool(tool *protocol.Tool) []string {
	if tool == nil {
		return []string{"⚙ tool"}
	}
	head := "⚙ " + tool.Title
	if tool.Kind != "" {
		head += " (" + tool.Kind + ")"
	}
	if tool.Status != "" {
		head += " [" + tool.Status + "]"
	}
	lines := []string{head}
	for _, content := range tool.Content {
		switch content.Type {
		case "text":
			lines = append(lines, blockLines("    ", content.Text)...)
		case "diff":
			lines = append(lines, "    ± "+content.Path)
		}
	}
	for _, location := range tool.Locations {
		lines = append(lines, "    @ "+location)
	}
	return lines
}

func renderPlan(state *protocol.State) []string {
	if len(state.Plan) == 0 {
		return nil
	}
	lines := []string{"plan"}
	for _, item := range state.Plan {
		marker := "[ ]"
		switch item.Status {
		case protocol.PlanCompleted:
			marker = "[x]"
		case protocol.PlanInProgress:
			marker = "[~]"
		}
		lines = append(lines, "  "+marker+" "+item.Content)
	}
	return lines
}

func (m *Model) renderTail() []string {
	if m.state == nil {
		return nil
	}
	var lines []string
	if m.errText != "" {
		lines = append(lines, "! "+m.errText)
	}
	if m.status != "" {
		lines = append(lines, m.status)
	}
	lines = append(lines, renderPlan(m.state)...)
	if m.state.Permission != nil {
		lines = append(lines, m.renderPermission()...)
	}
	if len(m.state.Queue) > 0 {
		lines = append(lines, renderQueue(m.state)...)
	}
	if m.menu != nil {
		lines = append(lines, m.renderMenu()...)
	}
	lines = append(lines, m.renderComposer()...)
	lines = append(lines, m.renderFooter())
	return lines
}

func (m *Model) renderPermission() []string {
	permission := m.state.Permission
	lines := []string{"permission: " + permission.Title}
	if len(permission.Options) == 0 {
		return append(lines, "  (the request offers no options)")
	}
	index := m.permIndex
	if index >= len(permission.Options) {
		index = len(permission.Options) - 1
	}
	for i, option := range permission.Options {
		cursor := "  "
		if i == index {
			cursor = "> "
		}
		lines = append(lines, "  "+cursor+displayName(option.Name, option.ID))
	}
	return lines
}

func renderQueue(state *protocol.State) []string {
	lines := make([]string, 0, len(state.Queue)+1)
	lines = append(lines, "queued")
	for _, item := range state.Queue {
		lines = append(lines, "  "+item.ID+"  "+firstLine(item.Text))
	}
	return lines
}

func (m *Model) renderMenu() []string {
	page := m.menu.current()
	lines := []string{"── " + page.title}
	if len(page.items) == 0 {
		return append(lines, "  (no choices)")
	}
	for i, item := range page.items {
		cursor := "  "
		if i == page.index {
			cursor = "> "
		}
		lines = append(lines, "  "+cursor+item.label)
	}
	return lines
}

func (m *Model) renderComposer() []string {
	display := m.composer.displayLines(maxComposerLines)
	lines := make([]string, 0, len(display))
	for _, line := range display {
		lines = append(lines, "│ "+line)
	}
	if len(lines) == 0 {
		lines = append(lines, "│ ")
	}
	return lines
}

func (m *Model) renderFooter() string {
	if m.menu != nil {
		return "↑↓ move · enter select · esc back · ctrl+o close"
	}
	if m.state.Permission != nil {
		return "↑↓ choose · enter answer · esc cancel turn"
	}
	if m.cancelArmed {
		return "esc again cancels the turn"
	}
	return "enter send · shift+enter newline · ctrl+o modes · esc cancel · ctrl+c twice quit"
}

// windowLines returns height lines ending offset lines from the end.
func windowLines(lines []string, height, offset int) []string {
	if height < 1 {
		height = 1
	}
	if len(lines) <= height {
		return lines
	}
	end := len(lines) - offset
	if end > len(lines) {
		end = len(lines)
	}
	if end < height {
		end = height
	}
	return lines[end-height : end]
}

func prefixLines(prefix, text string) []string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for i, line := range lines {
		if i == 0 {
			out = append(out, prefix+line)
			continue
		}
		out = append(out, "  "+line)
	}
	return out
}

// blockLines indents every line of a tool result.
func blockLines(prefix, text string) []string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		out = append(out, prefix+line)
	}
	return out
}

func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return text[:index]
	}
	return text
}
