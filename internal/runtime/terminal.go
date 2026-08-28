package runtime

import "context"

const (
	TerminalMinCols = 20
	TerminalMaxCols = 320
	TerminalMinRows = 5
	TerminalMaxRows = 160
)

// TerminalOpener is the live-terminal seam. Herdr and the in-memory runtime
// both satisfy it; the daemon owns authorization, encryption and lifecycle.
type TerminalOpener interface {
	OpenTerminal(context.Context, TerminalOpen) (TerminalController, error)
}

type TerminalOpen struct {
	Session  SessionRef
	PaneID   string
	Cols     int
	Rows     int
	Takeover bool
}

type TerminalFrame struct {
	Sequence uint64
	Width    int
	Height   int
	Full     bool
	Data     []byte
}

type TerminalClosed struct {
	Reason string
	Err    error
}

type TerminalEvent struct {
	Frame  *TerminalFrame
	Closed *TerminalClosed
}

type TerminalResize struct {
	Cols         int
	Rows         int
	CellWidthPX  int
	CellHeightPX int
}

type TerminalScroll struct {
	Direction string
	Lines     int
	Source    string
	Column    *int
	Row       *int
	Modifiers int
}

// TerminalController hides the child-process and Herdr wire details. Events
// stay ordered; callers must keep draining them until Closed or Close.
type TerminalController interface {
	Events() <-chan TerminalEvent
	Input([]byte) error
	Resize(TerminalResize) error
	Scroll(TerminalScroll) error
	Close() error
}

func ValidTerminalSize(cols, rows int) bool {
	return cols >= TerminalMinCols && cols <= TerminalMaxCols && rows >= TerminalMinRows && rows <= TerminalMaxRows
}
