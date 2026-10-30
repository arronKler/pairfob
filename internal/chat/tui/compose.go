package tui

import "strings"

// cursorRune marks the insertion point inside the composer.
const cursorRune = "▏"

// composer is the multiline prompt editor. It keeps runes, not bytes, so the
// cursor never splits a character.
type composer struct {
	text   []rune
	cursor int
}

func (c *composer) Insert(text string) {
	if text == "" {
		return
	}
	runes := []rune(text)
	next := make([]rune, 0, len(c.text)+len(runes))
	next = append(next, c.text[:c.cursor]...)
	next = append(next, runes...)
	next = append(next, c.text[c.cursor:]...)
	c.text = next
	c.cursor += len(runes)
}

func (c *composer) Newline() { c.Insert("\n") }

func (c *composer) Backspace() {
	if c.cursor == 0 {
		return
	}
	c.text = append(c.text[:c.cursor-1], c.text[c.cursor:]...)
	c.cursor--
}

func (c *composer) Delete() {
	if c.cursor >= len(c.text) {
		return
	}
	c.text = append(c.text[:c.cursor], c.text[c.cursor+1:]...)
}

func (c *composer) Left() {
	if c.cursor > 0 {
		c.cursor--
	}
}

func (c *composer) Right() {
	if c.cursor < len(c.text) {
		c.cursor++
	}
}

func (c *composer) Home() { c.cursor = 0 }

func (c *composer) End() { c.cursor = len(c.text) }

func (c *composer) Text() string { return string(c.text) }

func (c *composer) SetText(text string) {
	c.text = []rune(text)
	c.cursor = len(c.text)
}

func (c *composer) Clear() {
	c.text = nil
	c.cursor = 0
}

func (c *composer) Empty() bool { return len(c.text) == 0 }

// displayLines renders the text with the cursor marker, windowing long input
// so the cursor line stays visible.
func (c *composer) displayLines(max int) []string {
	before := string(c.text[:c.cursor])
	after := string(c.text[c.cursor:])
	lines := strings.Split(before+cursorRune+after, "\n")
	if max <= 0 || len(lines) <= max {
		return lines
	}
	cursorLine := strings.Count(before, "\n")
	start := cursorLine - max + 1
	if start < 0 {
		start = 0
	}
	if start+max > len(lines) {
		start = len(lines) - max
	}
	visible := append([]string(nil), lines[start:start+max]...)
	if start > 0 {
		visible[0] = "…"
	}
	return visible
}
