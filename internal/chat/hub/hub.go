// Package hub owns one chat transcript. Every mutation is a protocol op list
// applied atomically to protocol.State, numbered in the process epoch, and
// fanned out to views as one protocol.Change. The hub is the only writer.
package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

const (
	defaultHistoryChanges = 4096
	defaultHistoryBytes   = 16 << 20
	// subscribeBuffer is enough for a view that renders one frame per change.
	subscribeBuffer = 256
	// maxQueue is a guard against an endpoint that floods prompts.
	maxQueue = 256
)

// Agent is the ACP client the hub drives. acp.Client satisfies it.
type Agent interface {
	Events() <-chan acp.Event
	Prompt(ctx context.Context, sessionID string, blocks []acp.ContentBlock) (acp.PromptResult, error)
	Cancel(sessionID string) error
	SetMode(ctx context.Context, sessionID, modeID string) error
	SetConfigOption(ctx context.Context, sessionID, configID, value string) error
	AnswerPermission(requestID, optionID string) error
}

// Config describes one chat process.
type Config struct {
	ID    string
	Agent string
	Title string
	// HistoryChanges and HistoryBytes cap the replay window. Zero means the
	// protocol default (4096 changes or 16 MiB).
	HistoryChanges int
	HistoryBytes   int
}

// CommandError is a failed view command with a pairfob-chat.v1 error code.
type CommandError struct {
	Code    string
	Message string
}

func (e *CommandError) Error() string { return e.Message }

func commandErrorf(code, format string, args ...any) *CommandError {
	return &CommandError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Hub is the single writer of one transcript.
type Hub struct {
	agent Agent
	cfg   Config

	mu           sync.Mutex
	state        *protocol.State
	epoch        string
	seq          int64
	history      []protocol.Change
	historySizes []int
	historyBytes int
	subs         map[*Subscription]struct{}

	sessionID string
	ready     bool
	active    bool
	turn      int
	nextQueue int
	queued    map[string][]acp.ContentBlock
}

// New starts an empty transcript in the starting state.
func New(cfg Config) *Hub {
	return &Hub{
		agent:  nil,
		cfg:    cfg,
		state:  protocol.NewState(cfg.ID, cfg.Agent, cfg.Title),
		epoch:  newEpoch(),
		subs:   make(map[*Subscription]struct{}),
		queued: make(map[string][]acp.ContentBlock),
	}
}

// SetAgent attaches the ACP client. It must be called before Run.
func (h *Hub) SetAgent(agent Agent) {
	h.mu.Lock()
	h.agent = agent
	h.mu.Unlock()
}

// Run consumes ACP events until the adapter stream ends. Call it once, after
// SetAgent.
func (h *Hub) Run() {
	h.mu.Lock()
	agent := h.agent
	h.mu.Unlock()
	if agent == nil {
		return
	}
	for event := range agent.Events() {
		switch event.Kind {
		case acp.EventUpdate:
			h.onUpdate(event.Update)
		case acp.EventPermission:
			h.onPermission(event.Permission)
		case acp.EventExit:
			h.onExit(event.Exit)
		}
	}
}

// Subscription streams changes to one view. A slow view is closed instead of
// blocking the writer.
type Subscription struct {
	C      <-chan protocol.Change
	ch     chan protocol.Change
	hub    *Hub
	once   sync.Once
	closed bool
}

// Close stops delivery. It is safe to call more than once.
func (s *Subscription) Close() {
	s.once.Do(func() {
		s.hub.mu.Lock()
		if !s.closed {
			s.closed = true
			delete(s.hub.subs, s)
			close(s.ch)
		}
		s.hub.mu.Unlock()
	})
}

// Attachment is what a new view needs before it follows the change stream.
// Exactly one of State and Changes is set.
type Attachment struct {
	Epoch   string
	Seq     int64
	State   *protocol.State
	Changes []protocol.Change
}

// Attach registers a view atomically and decides between a snapshot and a
// cursor replay. A nil or unusable cursor yields a snapshot.
func (h *Hub) Attach(cursor *protocol.Cursor, buffer int) (Attachment, *Subscription) {
	if buffer < 1 {
		buffer = subscribeBuffer
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	sub := &Subscription{ch: make(chan protocol.Change, buffer), hub: h}
	sub.C = sub.ch
	h.subs[sub] = struct{}{}

	attachment := Attachment{Epoch: h.epoch, Seq: h.seq}
	if changes, ok := h.replayLocked(cursor); ok {
		attachment.Changes = changes
		return attachment, sub
	}
	attachment.State = h.state.Clone()
	return attachment, sub
}

// Snapshot returns a deep copy of the current transcript.
func (h *Hub) Snapshot() *protocol.State {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state.Clone()
}

// Cursor returns the epoch and sequence of the current transcript.
func (h *Hub) Cursor() protocol.Cursor {
	h.mu.Lock()
	defer h.mu.Unlock()
	return protocol.Cursor{Epoch: h.epoch, Seq: h.seq}
}

// Ready applies the session's initial modes and options and makes the hub
// promptable.
func (h *Hub) Ready(session acp.Session) error {
	modes, mode, options := sessionSettings(session)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state.Status == protocol.StatusExited {
		return commandErrorf(protocol.ErrCodeAgent, "agent has exited")
	}
	if h.agent == nil {
		return commandErrorf(protocol.ErrCodeAgent, "agent is not attached")
	}
	h.sessionID = session.SessionID
	h.ready = true
	return h.applyLocked([]protocol.Op{
		{Op: protocol.OpSetModes, Modes: modes, Mode: mode},
		{Op: protocol.OpSetOptions, Options: options},
		{Op: protocol.OpSetStatus, Status: protocol.StatusIdle},
	})
}

// Fail records a startup failure and stops the hub from accepting prompts.
func (h *Hub) Fail(err error) {
	if err == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state.Status == protocol.StatusExited {
		return
	}
	h.active = false
	_ = h.applyLocked([]protocol.Op{
		{Op: protocol.OpSetError, Error: err.Error()},
		{Op: protocol.OpSetStatus, Status: protocol.StatusExited},
	})
}

// applyLocked applies one atomic change, records it and fans it out. Callers
// hold h.mu.
func (h *Hub) applyLocked(ops []protocol.Op) error {
	if len(ops) == 0 {
		return nil
	}
	if err := h.state.Apply(ops); err != nil {
		return err
	}
	h.seq++
	change := protocol.Change{Seq: h.seq, Ops: ops}
	h.recordLocked(change)
	h.fanoutLocked(change)
	return nil
}

func (h *Hub) recordLocked(change protocol.Change) {
	size := changeSize(change)
	h.history = append(h.history, change)
	h.historySizes = append(h.historySizes, size)
	h.historyBytes += size

	limits := h.limits()
	for len(h.history) > 0 &&
		(len(h.history) > limits.changes || h.historyBytes > limits.bytes) {
		h.historyBytes -= h.historySizes[0]
		h.history = h.history[1:]
		h.historySizes = h.historySizes[1:]
	}
}

type historyLimits struct {
	changes int
	bytes   int
}

func (h *Hub) limits() historyLimits {
	limits := historyLimits{changes: h.cfg.HistoryChanges, bytes: h.cfg.HistoryBytes}
	if limits.changes <= 0 {
		limits.changes = defaultHistoryChanges
	}
	if limits.bytes <= 0 {
		limits.bytes = defaultHistoryBytes
	}
	return limits
}

// replayLocked returns the changes after the cursor when the history still
// holds every one of them. An empty replay is reported as unavailable so the
// caller sends a snapshot: a changes frame with no changes fails validation.
func (h *Hub) replayLocked(cursor *protocol.Cursor) ([]protocol.Change, bool) {
	if cursor == nil || cursor.Epoch != h.epoch {
		return nil, false
	}
	if cursor.Seq < 0 || cursor.Seq >= h.seq {
		return nil, false
	}
	if len(h.history) == 0 || h.history[0].Seq > cursor.Seq+1 {
		return nil, false
	}
	if h.history[len(h.history)-1].Seq != h.seq {
		return nil, false
	}
	changes := make([]protocol.Change, 0, h.seq-cursor.Seq)
	for _, change := range h.history {
		if change.Seq > cursor.Seq {
			changes = append(changes, change)
		}
	}
	if len(changes) == 0 {
		return nil, false
	}
	return changes, true
}

func (h *Hub) fanoutLocked(change protocol.Change) {
	for sub := range h.subs {
		select {
		case sub.ch <- change:
		default:
			delete(h.subs, sub)
			sub.closed = true
			close(sub.ch)
		}
	}
}

// changeSize estimates the retained size of one change from its wire form.
func changeSize(change protocol.Change) int {
	data, err := json.Marshal(change)
	if err != nil {
		return 256
	}
	return len(data)
}

// newEpoch returns the 8 lowercase hex process epoch.
func newEpoch() string {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%08x", uint32(time.Now().UnixNano()))
	}
	return hex.EncodeToString(raw[:])
}

func nowMillis() int64 { return time.Now().UnixMilli() }
