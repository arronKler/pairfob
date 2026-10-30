package tui

import (
	"fmt"
	"testing"
)

func TestComposerEditsRunes(t *testing.T) {
	var editor composer
	editor.Insert("hello")
	editor.Newline()
	editor.Insert("world")
	if got := editor.Text(); got != "hello\nworld" {
		t.Fatalf("text = %q", got)
	}

	editor.Left()
	editor.Backspace()
	if got := editor.Text(); got != "hello\nword" {
		t.Fatalf("after backspace text = %q", got)
	}

	editor.Home()
	editor.Delete()
	if got := editor.Text(); got != "ello\nword" {
		t.Fatalf("after delete text = %q", got)
	}

	editor.End()
	editor.Insert("s")
	if got := editor.Text(); got != "ello\nwords" {
		t.Fatalf("after end insert text = %q", got)
	}

	if editor.Empty() {
		t.Fatal("composer reports empty with text")
	}
	editor.Clear()
	if !editor.Empty() {
		t.Fatal("composer still has text after clear")
	}
}

func TestComposerKeepsCursorVisible(t *testing.T) {
	var editor composer
	for i := 1; i <= 10; i++ {
		if i > 1 {
			editor.Newline()
		}
		editor.Insert(fmt.Sprintf("line-%d", i))
	}

	visible := editor.displayLines(3)
	if len(visible) != 3 {
		t.Fatalf("visible lines = %q", visible)
	}
	if visible[0] != "…" {
		t.Fatalf("first visible line = %q, want a truncation marker", visible[0])
	}
	if visible[2] != "line-10"+cursorRune {
		t.Fatalf("cursor line = %q", visible[2])
	}

	editor.Home()
	visible = editor.displayLines(3)
	if visible[0] != cursorRune+"line-1" {
		t.Fatalf("cursor line did not scroll into view: %q", visible)
	}
	if visible[1] != "line-2" || visible[2] != "line-3" {
		t.Fatalf("window = %q", visible)
	}
}
