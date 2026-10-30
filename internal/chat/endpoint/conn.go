package endpoint

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"pairfob/internal/chat/hub"
	"pairfob/internal/chat/protocol"
)

// dedupeWindow is how long a command id keeps its first result.
const dedupeWindow = 5 * time.Minute

type cachedResult struct {
	err *protocol.Error
	at  time.Time
}

// conn is one view connection.
type conn struct {
	server *Server
	nc     net.Conn
	epoch  string

	writeMu sync.Mutex
	dedupe  map[string]cachedResult
	sub     *hub.Subscription

	closeOnce sync.Once
}

func newConn(server *Server, nc net.Conn) *conn {
	return &conn{
		server: server,
		nc:     nc,
		dedupe: make(map[string]cachedResult),
	}
}

// serve runs the handshake, starts the change pump, then reads commands.
func (c *conn) serve() {
	defer c.close()
	scanner := bufio.NewScanner(c.nc)
	scanner.Buffer(make([]byte, 0, 64<<10), protocol.MaxLineBytes)

	if !scanner.Scan() {
		return
	}
	var hello protocol.ClientMessage
	if err := json.Unmarshal(scanner.Bytes(), &hello); err != nil ||
		hello.Type != protocol.TypeHello || hello.Validate() != nil {
		c.sendResult("hello", &protocol.Error{
			Code:    protocol.ErrCodeInvalid,
			Message: "first frame must be a valid hello",
		})
		return
	}

	attachment, sub := c.server.hub.Attach(hello.Cursor, subscriptionBuffer)
	c.sub = sub
	c.epoch = attachment.Epoch
	if !c.send(protocol.ServerMessage{
		V:     protocol.Version,
		Type:  protocol.TypeWelcome,
		Epoch: attachment.Epoch,
		Seq:   attachment.Seq,
	}) {
		return
	}
	if attachment.State != nil {
		if !c.send(protocol.ServerMessage{
			V:     protocol.Version,
			Type:  protocol.TypeSnapshot,
			Epoch: attachment.Epoch,
			Seq:   attachment.Seq,
			State: attachment.State,
		}) {
			return
		}
	} else if !c.send(protocol.ServerMessage{
		V:       protocol.Version,
		Type:    protocol.TypeChanges,
		Epoch:   attachment.Epoch,
		Seq:     attachment.Seq,
		Changes: attachment.Changes,
	}) {
		return
	}
	go c.pump()

	for scanner.Scan() {
		var message protocol.ClientMessage
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			return
		}
		if err := message.Validate(); err != nil {
			id := message.ID
			if id == "" {
				id = "frame"
			}
			if !c.sendResult(id, &protocol.Error{Code: protocol.ErrCodeInvalid, Message: err.Error()}) {
				return
			}
			if message.Type != protocol.TypeCommand {
				return
			}
			continue
		}
		switch message.Type {
		case protocol.TypePing:
			if !c.send(protocol.ServerMessage{V: protocol.Version, Type: protocol.TypePong}) {
				return
			}
		case protocol.TypePong:
		case protocol.TypeHello:
			c.sendResult("hello", &protocol.Error{
				Code:    protocol.ErrCodeInvalid,
				Message: "connection is already greeted",
			})
			return
		case protocol.TypeCommand:
			if !c.handleCommand(message) {
				return
			}
		}
	}
}

// pump streams every change after the handshake frame.
func (c *conn) pump() {
	for change := range c.sub.C {
		message := protocol.ServerMessage{
			V:       protocol.Version,
			Type:    protocol.TypeChanges,
			Epoch:   c.epoch,
			Seq:     change.Seq,
			Changes: []protocol.Change{change},
		}
		if !c.send(message) {
			c.close()
			return
		}
	}
	// The hub closes a slow view; the view must reconnect without a cursor.
	c.close()
}

func (c *conn) close() {
	c.closeOnce.Do(func() {
		if c.sub != nil {
			c.sub.Close()
		}
		_ = c.nc.Close()
	})
}

func (c *conn) send(message protocol.ServerMessage) bool {
	if err := message.Validate(); err != nil {
		return false
	}
	data, err := json.Marshal(message)
	if err != nil {
		return false
	}
	data = append(data, '\n')

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.nc.Write(data)
	return err == nil
}

func (c *conn) sendResult(id string, failure *protocol.Error) bool {
	ok := failure == nil
	return c.send(protocol.ServerMessage{
		V:     protocol.Version,
		Type:  protocol.TypeResult,
		ID:    id,
		OK:    &ok,
		Error: failure,
	})
}

func (c *conn) handleCommand(message protocol.ClientMessage) bool {
	now := time.Now()
	c.pruneDedupe(now)
	if cached, ok := c.dedupe[message.ID]; ok {
		return c.sendResult(message.ID, cached.err)
	}
	failure := c.run(message.Command)
	c.dedupe[message.ID] = cachedResult{err: failure, at: now}
	return c.sendResult(message.ID, failure)
}

func (c *conn) pruneDedupe(now time.Time) {
	for id, cached := range c.dedupe {
		if now.Sub(cached.at) > dedupeWindow {
			delete(c.dedupe, id)
		}
	}
}

func (c *conn) run(command *protocol.Command) *protocol.Error {
	if command == nil {
		return &protocol.Error{Code: protocol.ErrCodeInvalid, Message: "command frame has no command"}
	}
	var err error
	switch command.Kind {
	case protocol.CommandPrompt:
		err = c.server.hub.Prompt(command.Text, command.Attachments)
	case protocol.CommandCancel:
		err = c.server.hub.Cancel()
	case protocol.CommandAnswer:
		err = c.server.hub.Answer(command.RequestID, command.OptionID)
	case protocol.CommandSetMode:
		err = c.server.hub.SetMode(command.ModeID)
	case protocol.CommandSetOption:
		err = c.server.hub.SetOption(command.OptionID, command.Value)
	case protocol.CommandUnqueue:
		err = c.server.hub.Unqueue(command.QueueID)
	case protocol.CommandSetAutoAccept:
		if command.Enabled == nil {
			return &protocol.Error{Code: protocol.ErrCodeInvalid, Message: "set_auto_accept has no enabled flag"}
		}
		err = c.server.hub.SetAutoAccept(*command.Enabled)
	default:
		return &protocol.Error{Code: protocol.ErrCodeInvalid, Message: "unknown command kind " + command.Kind}
	}
	return commandError(err)
}

func commandError(err error) *protocol.Error {
	if err == nil {
		return nil
	}
	var commandErr *hub.CommandError
	if errors.As(err, &commandErr) {
		return &protocol.Error{Code: commandErr.Code, Message: commandErr.Message}
	}
	return &protocol.Error{Code: protocol.ErrCodeAgent, Message: err.Error()}
}
