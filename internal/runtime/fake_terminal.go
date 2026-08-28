package runtime

import (
	"context"
	"errors"
	"strings"
	"sync"
)

func ptyText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.ReplaceAll(text, "\n", "\r\n")
}

type fakeTerminal struct {
	runtime   *Fake
	paneID    string
	events    chan TerminalEvent
	mu        sync.Mutex
	closed    bool
	closeOnce sync.Once
	sequence  uint64
	cols      int
	rows      int
}

func (f *Fake) OpenTerminal(ctx context.Context, open TerminalOpen) (TerminalController, error) {
	if err := contextFault("terminal.open", ctx.Err(), false); err != nil {
		return nil, err
	}
	if !validResourceID.MatchString(open.PaneID) || !ValidTerminalSize(open.Cols, open.Rows) {
		return nil, invalidFault("terminal.open", "invalid terminal target or size")
	}
	f.mu.Lock()
	pane := f.Panes[open.PaneID]
	if pane == nil {
		f.mu.Unlock()
		return nil, notFoundFault("terminal.open", EntityPane, open.PaneID)
	}
	text := pane.Text
	f.mu.Unlock()
	terminal := &fakeTerminal{
		runtime: f, paneID: open.PaneID, events: make(chan TerminalEvent, 16),
		sequence: 1, cols: open.Cols, rows: open.Rows,
	}
	terminal.events <- TerminalEvent{Frame: &TerminalFrame{
		Sequence: terminal.sequence, Width: open.Cols, Height: open.Rows, Full: true,
		Data: []byte("\x1b[2J\x1b[H" + ptyText(text)),
	}}
	return terminal, nil
}

func (t *fakeTerminal) Events() <-chan TerminalEvent { return t.events }

func (t *fakeTerminal) Input(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errors.New("terminal bridge is closed")
	}
	t.runtime.mu.Lock()
	pane := t.runtime.Panes[t.paneID]
	if pane == nil {
		t.runtime.mu.Unlock()
		return notFoundFault("terminal.input", EntityPane, t.paneID)
	}
	pane.Texts = append(pane.Texts, string(data))
	if !pane.EchoOff {
		pane.Text += string(data)
	}
	t.runtime.mu.Unlock()
	t.sequence++
	t.events <- TerminalEvent{Frame: &TerminalFrame{
		Sequence: t.sequence, Width: t.cols, Height: t.rows, Data: append([]byte(nil), data...),
	}}
	return nil
}

func (t *fakeTerminal) Resize(size TerminalResize) error {
	if !ValidTerminalSize(size.Cols, size.Rows) {
		return invalidFault("terminal.resize", "invalid terminal size")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errors.New("terminal bridge is closed")
	}
	t.cols, t.rows = size.Cols, size.Rows
	t.runtime.mu.Lock()
	pane := t.runtime.Panes[t.paneID]
	text := ""
	if pane != nil {
		text = pane.Text
	}
	t.runtime.mu.Unlock()
	t.sequence++
	t.events <- TerminalEvent{Frame: &TerminalFrame{
		Sequence: t.sequence, Width: t.cols, Height: t.rows, Full: true,
		Data: []byte("\x1b[2J\x1b[H" + ptyText(text)),
	}}
	return nil
}

func (t *fakeTerminal) Scroll(scroll TerminalScroll) error {
	if (scroll.Direction != "up" && scroll.Direction != "down") || scroll.Lines < 1 {
		return invalidFault("terminal.scroll", "invalid terminal scroll")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return errors.New("terminal bridge is closed")
	}
	return nil
}

func (t *fakeTerminal) Close() error {
	t.closeOnce.Do(func() {
		t.mu.Lock()
		t.closed = true
		t.mu.Unlock()
		t.events <- TerminalEvent{Closed: &TerminalClosed{Reason: "released"}}
		close(t.events)
	})
	return nil
}
