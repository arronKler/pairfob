package runtime

import (
	"context"
	"time"
)

const coreInputIdle = 5 * time.Second

// One attach viewer per terminal carries typed bytes. It is opened at the
// terminal's current cols/rows so typing does not resize the program, reused
// across sends, and closed after an idle window. The daemon sends Enter
// separately; this channel never submits.
type coreInputStream struct {
	terminal string
	channel  uint32
	cols     int
	rows     int
	last     time.Time
	timer    *time.Timer
	closed   bool
}

// coreInput returns an attach channel whose grid matches the terminal now.
// The stream is opened at the current size and reused across sends; if another
// viewer resized the shared terminal in between, the stale stream is resized
// before typing instead of shrinking that viewer back.
func (c *Core) coreInput(ctx context.Context, conn coreTransport, terminal, operation string) (uint32, error) {
	var info coreTerminal
	if err := conn.Call(ctx, "terminal.get", map[string]any{"terminal": terminal}, &info); err != nil {
		return 0, err
	}
	if err := validateCoreTerminal("terminal.get", info); err != nil {
		return 0, err
	}
	if info.State != "live" {
		return 0, &Fault{
			Code: CodeNotReady, Operation: operation, Outcome: OutcomeNotApplied,
			Retry: RetryNever, SafeMessage: "terminal has finished",
		}
	}
	if info.Cols == 0 || info.Rows == 0 {
		return 0, &Fault{
			Code: CodeNotReady, Operation: operation, Outcome: OutcomeNotApplied,
			Retry: RetryNever, SafeMessage: "terminal size is unknown",
		}
	}
	cols, rows := int(info.Cols), int(info.Rows)
	if channel, stale, ok := c.touchCoreInputSize(terminal, cols, rows); ok {
		if stale {
			if err := conn.ResizeInput(channel, cols, rows); err != nil {
				return 0, err
			}
			c.setCoreInputSize(terminal, channel, cols, rows)
		}
		return channel, nil
	}
	channel, err := conn.OpenInput(ctx, terminal, cols, rows)
	if err != nil {
		return 0, err
	}
	c.inputMu.Lock()
	if c.inputs == nil {
		c.inputMu.Unlock()
		_ = conn.CloseInput(channel)
		return 0, &Fault{
			Code: CodeOffline, Operation: operation, Outcome: OutcomeNotApplied,
			Retry: RetryUserOnly, SafeMessage: "the terminal core runtime is closed",
		}
	}
	for _, stream := range c.inputs {
		if stream.channel == channel {
			c.inputMu.Unlock()
			_ = conn.CloseInput(channel)
			return 0, coreProtocol(operation, "terminal core returned a duplicate input channel")
		}
	}
	stream := &coreInputStream{terminal: terminal, channel: channel, cols: cols, rows: rows, last: time.Now()}
	c.inputs[terminal] = stream
	c.armCoreInput(stream)
	c.inputMu.Unlock()
	return channel, nil
}

func (c *Core) touchCoreInputSize(terminal string, cols, rows int) (channel uint32, stale, ok bool) {
	c.inputMu.Lock()
	defer c.inputMu.Unlock()
	stream := c.inputs[terminal]
	if stream == nil || stream.closed {
		return 0, false, false
	}
	stream.last = time.Now()
	if stream.timer != nil {
		stream.timer.Reset(c.coreInputWindow())
	}
	return stream.channel, stream.cols != cols || stream.rows != rows, true
}

func (c *Core) setCoreInputSize(terminal string, channel uint32, cols, rows int) {
	c.inputMu.Lock()
	defer c.inputMu.Unlock()
	stream := c.inputs[terminal]
	if stream == nil || stream.closed || stream.channel != channel {
		return
	}
	stream.cols, stream.rows = cols, rows
}

func (c *Core) coreInputWindow() time.Duration {
	if c.inputIdle > 0 {
		return c.inputIdle
	}
	return coreInputIdle
}

func (c *Core) armCoreInput(stream *coreInputStream) {
	stream.timer = time.AfterFunc(c.coreInputWindow(), func() { c.expireCoreInput(stream) })
}

func (c *Core) expireCoreInput(stream *coreInputStream) {
	c.inputMu.Lock()
	if c.inputs == nil || c.inputs[stream.terminal] != stream || stream.closed {
		c.inputMu.Unlock()
		return
	}
	if remaining := c.coreInputWindow() - time.Since(stream.last); remaining > 0 {
		stream.timer.Reset(remaining)
		c.inputMu.Unlock()
		return
	}
	delete(c.inputs, stream.terminal)
	stream.closed = true
	c.inputMu.Unlock()

	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn != nil {
		_ = conn.CloseInput(stream.channel)
	}
}

func (c *Core) closeCoreInput(terminal string) error {
	c.inputMu.Lock()
	stream := c.inputs[terminal]
	if stream == nil {
		c.inputMu.Unlock()
		return nil
	}
	delete(c.inputs, terminal)
	stream.closed = true
	if stream.timer != nil {
		stream.timer.Stop()
	}
	c.inputMu.Unlock()

	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		return nil
	}
	return conn.CloseInput(stream.channel)
}

func (c *Core) forgetCoreInputChannel(channel uint32) {
	c.inputMu.Lock()
	defer c.inputMu.Unlock()
	for terminal, stream := range c.inputs {
		if stream.channel != channel {
			continue
		}
		delete(c.inputs, terminal)
		stream.closed = true
		if stream.timer != nil {
			stream.timer.Stop()
		}
	}
}

func (c *Core) forgetCoreInputs() {
	c.inputMu.Lock()
	defer c.inputMu.Unlock()
	for terminal, stream := range c.inputs {
		delete(c.inputs, terminal)
		stream.closed = true
		if stream.timer != nil {
			stream.timer.Stop()
		}
	}
}

// closeCoreInputs marks the registry unusable as well as empty, so an
// in-flight send that outlived Core.Close cannot install a new stream.
func (c *Core) closeCoreInputs() {
	c.forgetCoreInputs()
	c.inputMu.Lock()
	c.inputs = nil
	c.inputMu.Unlock()
}
