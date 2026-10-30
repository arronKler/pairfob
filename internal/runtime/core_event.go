package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
)

var errTerminalCoreClosed = errors.New("terminal core event stream closed")

// Core events are JSON lines on a channel of their own, opened by
// events.subscribe. The stream uses a dedicated hc connection so a resubscribe
// or a dropped event channel never disturbs RPC calls or attach streams.
const (
	coreEventBuffer  = 64
	coreEventLineMax = 1 << 20
)

type coreEventNotification struct {
	Method string `json:"method"`
	Params struct {
		Data     json.RawMessage `json:"data"`
		Seq      uint64          `json:"seq"`
		Terminal string          `json:"terminal"`
		Type     string          `json:"type"`
	} `json:"params"`
}

type coreEventStream struct {
	core  *Core
	conn  coreTransport
	items <-chan coreStreamItem
	panes map[string]bool

	events chan Event
	done   chan struct{}
	closed chan struct{}

	closeOnce sync.Once
	mu        sync.Mutex
	err       error
}

func (c *Core) SubscribeEvents(ctx context.Context, session SessionRef, subscription EventSubscription) (EventStream, error) {
	const operation = "events.subscribe"
	if err := coreDefaultSession(operation, session); err != nil {
		return nil, err
	}
	panes, err := coreEventPaneIDs(subscription.PaneIDs)
	if err != nil {
		return nil, err
	}
	c.connMu.Lock()
	closed := c.closed
	c.connMu.Unlock()
	if closed {
		return nil, coreClosedFault(operation)
	}
	conn, hello, err := c.dialer()(ctx)
	if err != nil {
		return nil, coreFault(operation, err, false, false)
	}
	pusher, supported := conn.(corePushTransport)
	if !hello.has("events.subscribe") || !supported {
		_ = conn.Close()
		return nil, unsupported(operation, "event subscriptions are unsupported by the terminal core")
	}
	_, items, err := pusher.OpenEvents(ctx)
	if err != nil {
		_ = conn.Close()
		return nil, coreFault(operation, err, false, false)
	}
	stream := &coreEventStream{
		core: c, conn: conn, items: items, panes: panes,
		events: make(chan Event, coreEventBuffer), done: make(chan struct{}), closed: make(chan struct{}),
	}
	if !c.trackEventStream(stream) {
		_ = conn.Close()
		return nil, coreClosedFault(operation)
	}
	go stream.read()
	return stream, nil
}

func coreEventPaneIDs(values []string) (map[string]bool, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := make(map[string]bool, len(values))
	for _, paneID := range values {
		if _, err := decodeCorePaneID(paneID); err != nil {
			return nil, invalidFault("events.subscribe", "invalid event pane id")
		}
		out[paneID] = true
	}
	return out, nil
}

func (s *coreEventStream) Events() <-chan Event  { return s.events }
func (s *coreEventStream) Done() <-chan struct{} { return s.done }

func (s *coreEventStream) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// Close is idempotent and owns the dedicated connection. The events channel is
// closed by the reader, so a caller that only closes the stream still sees the
// channel end.
func (s *coreEventStream) Close() error {
	s.closeOnce.Do(func() {
		close(s.closed)
		_ = s.conn.Close()
		if s.core != nil {
			s.core.forgetEventStream(s)
		}
	})
	return nil
}

func (s *coreEventStream) setErr(err error) {
	s.mu.Lock()
	if s.err == nil {
		s.err = err
	}
	s.mu.Unlock()
}

func (s *coreEventStream) read() {
	defer close(s.done)
	defer close(s.events)
	var pending []byte
	for {
		select {
		case <-s.closed:
			return
		case item, ok := <-s.items:
			if !ok {
				s.eventChannelClosed()
				return
			}
			if item.kind != coreKindData {
				continue
			}
			pending = append(pending, item.payload...)
			for {
				index := bytes.IndexByte(pending, '\n')
				if index < 0 {
					break
				}
				line := pending[:index]
				pending = pending[index+1:]
				if len(bytes.TrimSpace(line)) == 0 {
					continue
				}
				event, emit, err := decodeCoreEvent(line, s.panes)
				if err != nil {
					s.fail(err)
					return
				}
				if !emit {
					continue
				}
				// Events are invalidations; the caller reconciles after each one.
				// Keep the newest and drop the oldest instead of ending the
				// stream when a slow caller lets the buffer fill.
				select {
				case s.events <- event:
				case <-s.closed:
					return
				default:
					select {
					case <-s.events:
					default:
					}
					select {
					case s.events <- event:
					default:
					}
				}
			}
			if len(pending) > coreEventLineMax {
				s.fail(coreProtocol("events.subscribe", "terminal core event line is too large"))
				return
			}
		}
	}
}

// eventChannelClosed ends the stream without treating it as a failure of the
// shared runtime. The caller reconnects and resubscribes.
func (s *coreEventStream) eventChannelClosed() {
	select {
	case <-s.closed:
		return
	default:
	}
	s.setErr(coreFault("events.subscribe", &coreTransportError{cause: errTerminalCoreClosed}, false, false))
	_ = s.conn.Close()
}

func (s *coreEventStream) fail(err error) {
	select {
	case <-s.closed:
		return
	default:
	}
	s.setErr(err)
	_ = s.conn.Close()
}

func decodeCoreEvent(line []byte, panes map[string]bool) (Event, bool, error) {
	var note coreEventNotification
	if err := json.Unmarshal(line, &note); err != nil {
		return Event{}, false, coreProtocol("events.subscribe", "invalid terminal core event")
	}
	if note.Method != "event" || note.Params.Type == "" {
		return Event{}, false, nil
	}
	terminal := note.Params.Terminal
	switch note.Params.Type {
	case "status":
		paneID, ok := coreEventPane(terminal)
		if !ok {
			return Event{}, false, coreProtocol("events.subscribe", "invalid terminal core event")
		}
		if panes != nil && !panes[paneID] {
			return Event{}, false, nil
		}
		var data struct {
			Status *coreStatus `json:"status"`
		}
		if len(note.Params.Data) > 0 {
			if err := json.Unmarshal(note.Params.Data, &data); err != nil {
				return Event{}, false, coreProtocol("events.subscribe", "invalid terminal core status event")
			}
		}
		return Event{Kind: EventAgentStatus, PaneID: paneID, AgentStatus: coreEventStatus(data.Status)}, true, nil
	case "created", "lost", "restarted", "keep", "finished", "removed", "title", "labels":
		// Membership and user-visible facts the caller rediscovers from a
		// snapshot. Size, turn and doc changes are not membership changes and
		// would only add reconciles.
		paneID, ok := coreEventPane(terminal)
		if !ok {
			return Event{}, false, coreProtocol("events.subscribe", "invalid terminal core event")
		}
		return Event{Kind: EventStructure, PaneID: paneID}, true, nil
	case "missed":
		// Events were dropped. A structure event makes the caller reconcile
		// now instead of waiting for its next periodic snapshot.
		paneID, _ := coreEventPane(terminal)
		return Event{Kind: EventStructure, PaneID: paneID}, true, nil
	default:
		// heartbeat, foreground, turn and doc changes do not invalidate the
		// phone's membership or status view.
		return Event{}, false, nil
	}
}

func coreEventPane(terminal string) (string, bool) {
	if !coreAddressPattern.MatchString(terminal) {
		return "", false
	}
	return encodeCoreAddress(terminal), true
}

// coreEventStatus maps the core's own status words onto the phone vocabulary.
// error is an attention state, and clear means the program withdrew its word.
func coreEventStatus(status *coreStatus) string {
	if status == nil {
		return ""
	}
	switch status.State {
	case "idle", "working", "done", "blocked":
		return status.State
	case "error":
		return "blocked"
	default:
		return ""
	}
}
