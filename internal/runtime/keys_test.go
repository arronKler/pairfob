package runtime

import "testing"

func TestCanonicalSendKeyMapsBrowserArrowsOntoHerdr(t *testing.T) {
	cases := map[string]string{
		"ArrowUp":    "up",
		"ArrowDown":  "down",
		"ArrowLeft":  "left",
		"ArrowRight": "right",
		"up":         "up",
		"Down":       "down",
		"Enter":      "enter",
		"enter":      "enter",
		"Esc":        "esc",
		"Escape":     "esc",
		"Tab":        "tab",
		"Backspace":  "backspace",
		"ctrl+c":     "ctrl+c",
		"1":          "1",
	}
	for input, want := range cases {
		got, ok := CanonicalSendKey(input)
		if !ok || got != want {
			t.Fatalf("%q -> %q ok=%v, want %q", input, got, ok, want)
		}
	}
	for _, key := range []string{"Home", "End", "Delete", "C-c", " ", "Arrow", "pageup", "PageUp", "pagedown", "PageDown"} {
		if _, ok := CanonicalSendKey(key); ok {
			t.Fatalf("%q must stay rejected", key)
		}
	}
}
