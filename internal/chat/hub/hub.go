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
	"slices"
	"strings"
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

	// maxChangeBytes reserves the changes envelope inside one line.
	maxChangeBytes = protocol.MaxLineBytes - (1 << 10)
	// maxSnapshotBudget keeps a snapshot below MaxSnapshotStateBytes with room
	// for the limit notice.
	maxSnapshotBudget = protocol.MaxSnapshotStateBytes - (1 << 10)
	// replayReserve is the changes envelope of a replay frame.
	replayReserve = 256
	// evictionBatch bounds one eviction change, keeping every removed id well
	// inside one frame even when thousands of tiny entries are dropped.
	evictionBatch = 256

	// Non-entry state is replaced wholesale by adapter events. These caps keep
	// one such replacement, and the retained state, inside the frame budget.
	maxQueuedPromptBytes      = 1 << 10
	maxPlanPayloadBytes       = 64 << 10
	maxModesPayloadBytes      = 32 << 10
	maxOptionsPayloadBytes    = 64 << 10
	maxPermissionPayloadBytes = 16 << 10
	maxTitleBytes             = 4 << 10

	// limitNoticeID marks the single notice reporting transcript eviction.
	limitNoticeID   = "notice-transcript-limit"
	limitNoticeText = "Older entries were removed to keep the transcript within its size limit."
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

	// Wire-size accounting for the retained state. entryWire caches the
	// encoded length of each entry and baseWire the encoded state without its
	// entry array, so the snapshot budget can be checked without marshaling
	// the whole transcript on every streaming chunk.
	entryWire    map[string]int
	entryWireSum int
	baseWire     int

	sessionID string
	ready     bool
	active    bool
	turn      int
	nextQueue int
	queued    map[string][]acp.ContentBlock
}

// New starts an empty transcript in the starting state. The title and agent
// label are clipped so a caller cannot seed a base state that no snapshot can
// carry.
func New(cfg Config) *Hub {
	state := protocol.NewState(cfg.ID, protocol.ClipText(cfg.Agent, maxTitleBytes), protocol.ClipText(cfg.Title, maxTitleBytes))
	return &Hub{
		agent:     nil,
		cfg:       cfg,
		state:     state,
		epoch:     newEpoch(),
		subs:      make(map[*Subscription]struct{}),
		queued:    make(map[string][]acp.ContentBlock),
		entryWire: make(map[string]int),
		baseWire:  stateShellWire(state),
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
//
// Payloads are clipped before they reach the state: oversized text keeps a
// visible TruncatedMarker instead of failing the apply, so a caller that
// ignores the returned error (the ACP event loop does) cannot silently lose an
// oversized tool update. The retained state is kept inside the snapshot budget
// by evicting its oldest entries.
func (h *Hub) applyLocked(ops []protocol.Op) error {
	if len(ops) == 0 {
		return nil
	}
	clipped, err := clipOps(h.state, ops)
	if err != nil {
		h.noteDroppedUpdateLocked()
		return err
	}
	if len(clipped) == 0 {
		return nil
	}
	change := protocol.Change{Seq: h.seq + 1, Ops: clipped}
	if changeSize(change) > maxChangeBytes {
		return fmt.Errorf("change exceeds the %d-byte frame budget", maxChangeBytes)
	}
	if err := h.state.Apply(clipped); err != nil {
		return err
	}
	h.accountLocked(clipped)
	h.evictLocked(clipped)
	h.emitLocked(clipped)
	return nil
}

// noteDroppedUpdateLocked leaves a visible notice when a payload cannot be
// clipped into the entry budget. The ACP event loop ignores apply errors, so
// this is how a rejected update stays visible instead of vanishing.
func (h *Hub) noteDroppedUpdateLocked() {
	const id = "notice-update-dropped"
	if _, ok := h.state.Entry(id); ok {
		return
	}
	entry := protocol.Entry{
		ID:    id,
		Kind:  protocol.KindNotice,
		Level: protocol.LevelWarning,
		Text:  "A chat update was dropped because it exceeded the transcript size limit.",
		At:    nowMillis(),
	}
	ops := []protocol.Op{{Op: protocol.OpAppendEntry, Entry: &entry}}
	if err := h.state.Apply(ops); err != nil {
		return
	}
	h.accountLocked(ops)
	h.emitLocked(ops)
}

// emitLocked numbers one applied change, records it and fans it out. The
// state already holds the ops.
func (h *Hub) emitLocked(ops []protocol.Op) {
	h.seq++
	change := protocol.Change{Seq: h.seq, Ops: ops}
	h.recordLocked(change)
	h.fanoutLocked(change)
}

// clipOps bounds every payload in one change so the change frame and the
// resulting state stay inside their line budgets. Truncation is visible in the
// transcript; ops that no longer carry new content (a stream past its entry
// budget) are dropped, but the entry itself was already recorded.
func clipOps(state *protocol.State, ops []protocol.Op) ([]protocol.Op, error) {
	out := make([]protocol.Op, 0, len(ops))
	pending := make(map[string]*protocol.Entry)
	for _, op := range ops {
		switch op.Op {
		case protocol.OpAppendEntry, protocol.OpSetEntry:
			if op.Entry == nil {
				out = append(out, op)
				continue
			}
			entry, _, err := clipEntry(*op.Entry)
			if err != nil {
				return nil, err
			}
			op.Entry = &entry
			seen := entry
			pending[entry.ID] = &seen
			out = append(out, op)
		case protocol.OpAppendText:
			entry, ok := pendingEntry(state, pending, op.ID)
			if !ok {
				out = append(out, op)
				continue
			}
			if strings.HasSuffix(entry.Text, protocol.TruncatedMarker) &&
				protocol.EntryWireBytes(*entry) >= protocol.MaxEntryWireBytes-64 {
				continue // the entry already reported its content limit
			}
			text := entry.Text + op.Text
			if entry.Tool == nil && len(text) <= (protocol.MaxEntryWireBytes-1024)/6 {
				entry.Text = text
				out = append(out, op)
				continue
			}
			combined := cloneEntry(*entry)
			combined.Text = text
			clipped, truncated, err := clipEntry(combined)
			if err != nil {
				return nil, err
			}
			pending[op.ID] = &clipped
			if !truncated {
				out = append(out, op)
				continue
			}
			emitted := clipped
			out = append(out, protocol.Op{Op: protocol.OpSetEntry, Entry: &emitted})
		case protocol.OpSetQueue:
			queue := append([]protocol.QueuedPrompt(nil), op.Queue...)
			if len(queue) > maxQueue {
				queue = queue[:maxQueue]
			}
			for i := range queue {
				queue[i].Text = protocol.ClipText(queue[i].Text, maxQueuedPromptBytes)
			}
			op.Queue = queue
			out = append(out, op)
		case protocol.OpSetPlan:
			op.Plan = clipList(op.Plan, maxPlanPayloadBytes)
			out = append(out, op)
		case protocol.OpSetModes:
			op.Modes = clipList(op.Modes, maxModesPayloadBytes)
			out = append(out, op)
		case protocol.OpSetOptions:
			op.Options = clipList(op.Options, maxOptionsPayloadBytes)
			out = append(out, op)
		case protocol.OpSetPermission:
			if op.Permission != nil {
				permission := *op.Permission
				permission.Title = protocol.ClipText(permission.Title, maxTitleBytes)
				permission.Options = clipList(permission.Options, maxPermissionPayloadBytes)
				op.Permission = &permission
			}
			out = append(out, op)
		case protocol.OpSetTitle:
			op.Title = protocol.ClipText(op.Title, maxTitleBytes)
			out = append(out, op)
		case protocol.OpSetError:
			op.Error = protocol.ClipText(op.Error, maxTitleBytes)
			out = append(out, op)
		default:
			out = append(out, op)
		}
	}
	return out, nil
}

// clipList keeps the longest prefix of one replaced list whose encoded form
// fits limit bytes. Entry content carries a marker; list metadata is advisory.
func clipList[T any](items []T, limit int) []T {
	for len(items) > 0 {
		data, err := json.Marshal(items)
		if err == nil && len(data) <= limit {
			break
		}
		items = items[:len(items)-1]
	}
	return items
}

// pendingEntry returns the change's view of an entry, cloning it from the live
// state on first use so a later op in the same change sees earlier edits.
func pendingEntry(state *protocol.State, pending map[string]*protocol.Entry, id string) (*protocol.Entry, bool) {
	if entry, ok := pending[id]; ok {
		return entry, true
	}
	entry, ok := state.Entry(id)
	if !ok {
		return nil, false
	}
	clone := cloneEntry(*entry)
	pending[id] = &clone
	return &clone, true
}

// clipEntry clones an entry and trims its largest text fields until the
// encoded entry fits MaxEntryWireBytes. TruncatedMarker records the loss. The
// boolean reports whether anything was dropped.
func clipEntry(entry protocol.Entry) (protocol.Entry, bool, error) {
	if protocol.EntryWireBytes(entry) <= protocol.MaxEntryWireBytes {
		return entry, false, nil
	}
	entry = cloneEntry(entry)
	// The marker's encoded cost exceeds its raw length (the newline is
	// escaped); keep a margin so the final entry stays under the cap.
	reserve := len(protocol.TruncatedMarker) + 8
	if entry.Tool != nil {
		reserve += 64 // the marker is a tool content block
	}
	budget := protocol.MaxEntryWireBytes - reserve
	for {
		size := protocol.EntryWireBytes(entry)
		if size <= budget {
			break
		}
		if !trimLargestText(&entry, size-budget) && !dropLastToolPart(&entry) {
			return entry, true, fmt.Errorf("entry %q cannot fit the %d-byte entry budget", entry.ID, protocol.MaxEntryWireBytes)
		}
	}
	if entry.Tool != nil {
		entry.Tool.Content = append(entry.Tool.Content, protocol.ToolContent{Type: "text", Text: protocol.TruncatedMarker})
	} else {
		entry.Text += protocol.TruncatedMarker
	}
	if protocol.EntryWireBytes(entry) > protocol.MaxEntryWireBytes {
		return entry, true, fmt.Errorf("entry %q exceeds the %d-byte entry budget", entry.ID, protocol.MaxEntryWireBytes)
	}
	return entry, true, nil
}

// trimLargestText cuts the longest string field by at least excess raw bytes.
// JSON escaping never grows when bytes are removed, so the encoded entry
// shrinks on every call until it fits or every field is empty.
func trimLargestText(entry *protocol.Entry, excess int) bool {
	fields := entryTextFields(entry)
	var largest *string
	for _, field := range fields {
		if largest == nil || len(*field) > len(*largest) {
			largest = field
		}
	}
	if largest == nil || len(*largest) == 0 {
		return false
	}
	cut := len(*largest) - excess
	if cut < 0 {
		cut = 0
	}
	*largest = protocol.TruncateUTF8(*largest, cut)
	return true
}

// dropLastToolPart removes one structural tool part when no text is left to
// trim, so many empty content blocks cannot pin an entry over its budget.
func dropLastToolPart(entry *protocol.Entry) bool {
	if entry.Tool == nil {
		return false
	}
	if n := len(entry.Tool.Content); n > 0 {
		entry.Tool.Content = entry.Tool.Content[:n-1]
		return true
	}
	if n := len(entry.Tool.Locations); n > 0 {
		entry.Tool.Locations = entry.Tool.Locations[:n-1]
		return true
	}
	return false
}

func entryTextFields(entry *protocol.Entry) []*string {
	fields := []*string{&entry.Text}
	if entry.Tool == nil {
		return fields
	}
	fields = append(fields, &entry.Tool.Title, &entry.Tool.Kind, &entry.Tool.Status)
	for i := range entry.Tool.Content {
		block := &entry.Tool.Content[i]
		fields = append(fields, &block.Text, &block.Path, &block.Old, &block.New)
	}
	for i := range entry.Tool.Locations {
		fields = append(fields, &entry.Tool.Locations[i])
	}
	return fields
}

func cloneEntry(entry protocol.Entry) protocol.Entry {
	if entry.Tool != nil {
		tool := *entry.Tool
		tool.Content = slices.Clone(entry.Tool.Content)
		tool.Locations = slices.Clone(entry.Tool.Locations)
		entry.Tool = &tool
	}
	return entry
}

// baseWireLocked returns the encoded state without its entry array; the entry
// array is accounted separately from entryWire.
func stateShellWire(state *protocol.State) int {
	shell := *state
	shell.Entries = nil
	data, err := json.Marshal(shell)
	if err != nil {
		return maxSnapshotBudget
	}
	return len(data)
}

// stateWireLocked returns the exact encoded size of the retained state.
func (h *Hub) stateWireLocked() int {
	size := h.baseWire - len("null") + 2
	if n := len(h.state.Entries); n > 0 {
		size += h.entryWireSum + n - 1
	}
	return size
}

// accountLocked refreshes the wire-size cache after ops were applied.
func (h *Hub) accountLocked(ops []protocol.Op) {
	touched, other := false, false
	for _, op := range ops {
		switch op.Op {
		case protocol.OpAppendEntry, protocol.OpSetEntry, protocol.OpAppendText,
			protocol.OpSetStreaming, protocol.OpRemoveEntry:
			touched = true
		default:
			other = true
		}
	}
	if touched {
		for _, op := range ops {
			id := opEntryID(op)
			if id == "" {
				continue
			}
			old := h.entryWire[id]
			if entry, ok := h.state.Entry(id); ok {
				size := protocol.EntryWireBytes(*entry)
				h.entryWire[id] = size
				h.entryWireSum += size - old
			} else {
				delete(h.entryWire, id)
				h.entryWireSum -= old
			}
		}
	}
	if other {
		h.baseWire = stateShellWire(h.state)
	}
}

func opEntryID(op protocol.Op) string {
	switch op.Op {
	case protocol.OpAppendEntry, protocol.OpSetEntry:
		if op.Entry != nil {
			return op.Entry.ID
		}
	case protocol.OpAppendText, protocol.OpSetStreaming, protocol.OpRemoveEntry:
		return op.ID
	}
	return ""
}

// evictLocked drops the oldest entries, in frame-sized batches, until the
// transcript fits the snapshot budget. Each batch is its own change, so one
// view frame never exceeds MaxLineBytes. Entries the current change refers to
// stay, keeping the original change applicable.
func (h *Hub) evictLocked(referenced []protocol.Op) {
	refs := make(map[string]struct{}, len(referenced))
	for _, op := range referenced {
		if id := opEntryID(op); id != "" {
			refs[id] = struct{}{}
		}
	}
	evicted := false
	for h.stateWireLocked() > maxSnapshotBudget {
		batch := h.nextEvictionLocked(refs)
		if len(batch) == 0 {
			break
		}
		if err := h.state.Apply(batch); err != nil {
			return
		}
		h.accountLocked(batch)
		h.emitLocked(batch)
		evicted = true
	}
	if !evicted {
		return
	}
	if _, ok := h.state.Entry(limitNoticeID); ok {
		return
	}
	notice := protocol.Entry{
		ID:    limitNoticeID,
		Kind:  protocol.KindNotice,
		Level: protocol.LevelWarning,
		Text:  limitNoticeText,
		At:    nowMillis(),
	}
	ops := []protocol.Op{{Op: protocol.OpAppendEntry, Entry: &notice}}
	if err := h.state.Apply(ops); err != nil {
		return
	}
	h.accountLocked(ops)
	h.emitLocked(ops)
}

// nextEvictionLocked selects the oldest unreferenced entries that bring the
// state under budget, capped at one eviction batch.
func (h *Hub) nextEvictionLocked(refs map[string]struct{}) []protocol.Op {
	var batch []protocol.Op
	projected := h.stateWireLocked()
	for i := range h.state.Entries {
		if projected <= maxSnapshotBudget || len(batch) >= evictionBatch {
			break
		}
		entry := &h.state.Entries[i]
		if _, ok := refs[entry.ID]; ok {
			continue
		}
		batch = append(batch, protocol.Op{Op: protocol.OpRemoveEntry, ID: entry.ID})
		projected -= protocol.EntryWireBytes(*entry) + 1
	}
	return batch
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
	size := replayReserve
	for i, change := range h.history {
		if change.Seq <= cursor.Seq {
			continue
		}
		size += h.historySizes[i] + 1
		if size > protocol.MaxLineBytes {
			// The replay would not fit one line. A snapshot is bounded by the
			// transcript budget, so it is the recoverable path.
			return nil, false
		}
		changes = append(changes, change)
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
