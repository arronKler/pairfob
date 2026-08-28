package runtime

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Herdr pane.send_keys spelling. Browser KeyboardEvent names such as ArrowUp
// are aliases. PageUp/PageDown/Home/End/Delete stay rejected: live Herdr's
// combo parser does not accept them (host scrollback owns those keys).
var herdrNamedKeys = map[string]string{
	"enter":      "enter",
	"esc":        "esc",
	"escape":     "esc",
	"tab":        "tab",
	"backspace":  "backspace",
	"up":         "up",
	"down":       "down",
	"left":       "left",
	"right":      "right",
	"arrowup":    "up",
	"arrowdown":  "down",
	"arrowleft":  "left",
	"arrowright": "right",
}

var herdrCtrlKey = regexp.MustCompile(`^ctrl\+[a-z]$`)

// CanonicalSendKey maps a Pairfob SendKeys token onto Herdr's key-combo string.
func CanonicalSendKey(key string) (string, bool) {
	if key == "" {
		return "", false
	}
	if mapped, ok := herdrNamedKeys[strings.ToLower(key)]; ok {
		return mapped, true
	}
	if herdrCtrlKey.MatchString(key) {
		return key, true
	}
	r, n := utf8.DecodeRuneInString(key)
	if r != utf8.RuneError && n == len(key) && unicode.IsPrint(r) && !unicode.IsSpace(r) {
		return key, true
	}
	return "", false
}

func canonicalSendKeys(keys []string) ([]string, bool) {
	out := make([]string, len(keys))
	for i, key := range keys {
		mapped, ok := CanonicalSendKey(key)
		if !ok {
			return nil, false
		}
		out[i] = mapped
	}
	return out, true
}
