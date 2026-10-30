package runtime

import (
	"context"
	"sync"
)

// coreTerminalController streams one core attach channel as the phone's full
// terminal. The attach channel's first DATA is the program's current screen;
// later DATA is live output. Frame sizes follow the viewer's grid, or the
// core's own RESIZE frame when another viewer changed it.
type coreTerminalController struct {
	conn    coreTransport
	channel uint32
	items   <-chan coreStreamItem

	events chan TerminalEvent
	closed chan struct{}

	closeOnce sync.Once
	mu        sync.Mutex
	width     int
	height    int
}

func (c *Core) OpenTerminal(ctx context.Context, open TerminalOpen) (TerminalController, error) {
	const operation = "terminal.open"
	if err := coreDefaultSession(operation, open.Session); err != nil {
		return nil, err
	}
	if open.PaneID == "" {
		return nil, invalidFault(operation, "invalid terminal target or size")
	}
	terminal, err := decodeCorePaneID(open.PaneID)
	if err != nil {
		return nil, invalidFault(operation, "invalid terminal target or size")
	}
	if !ValidTerminalSize(open.Cols, open.Rows) {
		return nil, invalidFault(operation, "invalid terminal target or size")
	}
	conn, hello, err := c.connection(ctx)
	if err != nil {
		return nil, err
	}
	if err := coreRequireMethod(hello, operation, "terminal.attach"); err != nil {
		return nil, err
	}
	frames, ok := conn.(coreFrameTransport)
	if !ok {
		return nil, unsupported(operation, "terminal streams are unsupported by the terminal core")
	}
	// Takeover has no core equivalent: an attach is a viewer, and the core
	// already arbitrates the program's real grid between viewers.
	channel, items, err := frames.OpenOutput(ctx, terminal, open.Cols, open.Rows)
	if err != nil {
		return nil, c.endCall(conn, operation, err, false, false)
	}
	controller := &coreTerminalController{
		conn: conn, channel: channel, items: items,
		events: make(chan TerminalEvent, 16), closed: make(chan struct{}),
		width: open.Cols, height: open.Rows,
	}
	go controller.read()
	return controller, nil
}

func (t *coreTerminalController) Events() <-chan TerminalEvent { return t.events }

func (t *coreTerminalController) read() {
	defer close(t.events)
	var sequence uint64
	for {
		select {
		case <-t.closed:
			return
		case item, ok := <-t.items:
			if !ok {
				t.emitClosed("terminal core stream closed")
				return
			}
			switch item.kind {
			case coreKindResize:
				if item.cols > 0 && item.rows > 0 {
					t.setSize(item.cols, item.rows)
				}
			case coreKindData:
				if len(item.payload) == 0 {
					continue
				}
				sequence++
				width, height := t.size()
				if !t.emit(TerminalEvent{Frame: &TerminalFrame{
					Sequence: sequence, Width: width, Height: height, Full: sequence == 1, Data: item.payload,
				}}) {
					return
				}
			}
		}
	}
}

func (t *coreTerminalController) emit(event TerminalEvent) bool {
	select {
	case t.events <- event:
		return true
	case <-t.closed:
		return false
	}
}

func (t *coreTerminalController) emitClosed(reason string) {
	select {
	case t.events <- TerminalEvent{Closed: &TerminalClosed{Reason: reason}}:
	case <-t.closed:
	}
}

func (t *coreTerminalController) size() (int, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.width, t.height
}

func (t *coreTerminalController) setSize(cols, rows int) {
	t.mu.Lock()
	t.width, t.height = cols, rows
	t.mu.Unlock()
}

func (t *coreTerminalController) closedForCommands() bool {
	select {
	case <-t.closed:
		return true
	default:
		return false
	}
}

func (t *coreTerminalController) Input(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if t.closedForCommands() {
		return coreTerminalClosedFault("terminal.input")
	}
	if err := t.conn.TypeInput(t.channel, data); err != nil {
		return coreFault("terminal.input", err, true, true)
	}
	return nil
}

func (t *coreTerminalController) Resize(size TerminalResize) error {
	if !ValidTerminalSize(size.Cols, size.Rows) {
		return invalidFault("terminal.resize", "invalid terminal size")
	}
	if t.closedForCommands() {
		return coreTerminalClosedFault("terminal.resize")
	}
	if err := t.conn.ResizeInput(t.channel, size.Cols, size.Rows); err != nil {
		return coreFault("terminal.resize", err, true, true)
	}
	// The frames that share a batch with the resize carry the grid the phone
	// asked for, even before the core answers with its own RESIZE frame.
	t.setSize(size.Cols, size.Rows)
	return nil
}

func (t *coreTerminalController) Scroll(TerminalScroll) error {
	return unsupported("terminal.scroll", "the terminal core has no scroll command")
}

func (t *coreTerminalController) Close() error {
	var err error
	t.closeOnce.Do(func() {
		close(t.closed)
		err = t.conn.CloseInput(t.channel)
	})
	return err
}

func coreTerminalClosedFault(operation string) error {
	return &Fault{
		Code: CodeOffline, Operation: operation, Outcome: OutcomeNotApplied,
		Retry: RetryUserOnly, SafeMessage: "terminal stream is closed",
	}
}
