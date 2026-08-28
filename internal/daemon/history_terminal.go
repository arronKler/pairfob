package daemon

import (
	"errors"
	"fmt"

	"pairfob/internal/runtime"
)

const (
	terminalHistoryCursorPrefix = "term:v1:"
	terminalHistoryMaxBytes     = 120 * 1024
)

var terminalHistoryWindows = [...]int{200, 400, 800, 1600, 3200, 4096}

// terminalHistoryWindow reserves one opaque History cursor namespace for the
// bounded rendered-pane fallback. The public RPC shape stays frozen and the
// phone cannot choose a Herdr pane.read source or an arbitrary line count.
func terminalHistoryWindow(cursor *string) (int, bool, error) {
	if cursor == nil || len(*cursor) < len("term:") || (*cursor)[:len("term:")] != "term:" {
		return 0, false, nil
	}
	for _, lines := range terminalHistoryWindows {
		if *cursor == fmt.Sprintf("%s%d", terminalHistoryCursorPrefix, lines) {
			return lines, true, nil
		}
	}
	return 0, true, errors.New("invalid terminal history cursor")
}

func nextTerminalHistoryCursor(lines int) *string {
	for i, current := range terminalHistoryWindows {
		if current == lines && i+1 < len(terminalHistoryWindows) {
			next := fmt.Sprintf("%s%d", terminalHistoryCursorPrefix, terminalHistoryWindows[i+1])
			return &next
		}
	}
	return nil
}

func (e *Engine) replyTerminalHistory(s *sess, id string, session *string, paneID string, lines int) {
	view, err := e.observe(session, runtime.PaneReadQuery{
		PaneID: paneID, Source: runtime.SourceRecentUnwrapped, Format: runtime.FormatText, Lines: lines,
	})
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	read, ok := view.(runtime.PaneReadView)
	if !ok {
		e.replyErr(s, id, "internal", "runtime returned an invalid pane view")
		return
	}
	text, clipped := truncateUTF8(read.Text, terminalHistoryMaxBytes)
	items := make([]map[string]string, 0, 1)
	if text != "" {
		items = append(items, map[string]string{"role": "assistant", "text": text})
	}
	var next *string
	if read.Truncated && !clipped {
		next = nextTerminalHistoryCursor(lines)
	}
	e.reply(s, id, map[string]any{
		"items": items, "next_cursor": next, "truncated": read.Truncated || clipped,
	})
}
