package daemon

import (
	"strconv"
	"testing"
)

func TestTerminalHistoryCursorUsesOnlyFrozenWindows(t *testing.T) {
	for i, lines := range terminalHistoryWindows {
		cursor := terminalHistoryCursorPrefix + strconv.Itoa(lines)
		got, terminal, err := terminalHistoryWindow(&cursor)
		if err != nil || !terminal || got != lines {
			t.Fatalf("cursor %q: lines=%d terminal=%v err=%v", cursor, got, terminal, err)
		}
		next := nextTerminalHistoryCursor(lines)
		if i == len(terminalHistoryWindows)-1 {
			if next != nil {
				t.Fatalf("4096-line window exposed another cursor: %q", *next)
			}
		} else if next == nil {
			t.Fatalf("window %d has no next cursor", lines)
		}
	}
	structured := "opaque-transcript-cursor"
	if _, terminal, err := terminalHistoryWindow(&structured); terminal || err != nil {
		t.Fatalf("structured cursor was captured: terminal=%v err=%v", terminal, err)
	}
	invalid := "term:v1:201"
	if _, terminal, err := terminalHistoryWindow(&invalid); !terminal || err == nil {
		t.Fatalf("invalid terminal cursor escaped: terminal=%v err=%v", terminal, err)
	}
}
