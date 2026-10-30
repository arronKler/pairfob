package protocol

import (
	"encoding/base64"
	"errors"
	"fmt"
)

// Version is the only pairfob-chat protocol version.
const Version = 1

const (
	// MaxLineBytes bounds one JSON line on the wire, and one text field.
	MaxLineBytes = 4 << 20
	// MaxAttachmentBytes bounds one attachment after base64 decoding.
	MaxAttachmentBytes = 8 << 20
)

// Message types, split by direction. Ping and pong travel both ways.
const (
	TypeHello    = "hello"
	TypeCommand  = "command"
	TypeWelcome  = "welcome"
	TypeSnapshot = "snapshot"
	TypeChanges  = "changes"
	TypeResult   = "result"
	TypePing     = "ping"
	TypePong     = "pong"
)

// Command kinds.
const (
	CommandPrompt        = "prompt"
	CommandCancel        = "cancel"
	CommandAnswer        = "answer"
	CommandSetMode       = "set_mode"
	CommandSetOption     = "set_option"
	CommandUnqueue       = "unqueue"
	CommandSetAutoAccept = "set_auto_accept"
)

// Change ops.
const (
	OpAppendEntry   = "append_entry"
	OpSetEntry      = "set_entry"
	OpAppendText    = "append_text"
	OpSetStreaming  = "set_streaming"
	OpRemoveEntry   = "remove_entry"
	OpSetStatus     = "set_status"
	OpSetPermission = "set_permission"
	OpSetPlan       = "set_plan"
	OpSetModes      = "set_modes"
	OpSetOptions    = "set_options"
	OpSetQueue      = "set_queue"
	OpSetAutoAccept = "set_auto_accept"
	OpSetTitle      = "set_title"
	OpSetUsage      = "set_usage"
	OpSetError      = "set_error"
)

// Agent lifecycle statuses.
const (
	StatusStarting = "starting"
	StatusIdle     = "idle"
	StatusWorking  = "working"
	StatusBlocked  = "blocked"
	StatusExited   = "exited"
)

// Entry kinds.
const (
	KindUser    = "user"
	KindAgent   = "agent"
	KindThought = "thought"
	KindTool    = "tool"
	KindNotice  = "notice"
)

// Entry levels.
const (
	LevelInfo    = "info"
	LevelWarning = "warning"
	LevelError   = "error"
)

// Plan item priorities and statuses.
const (
	PriorityHigh   = "high"
	PriorityMedium = "medium"
	PriorityLow    = "low"

	PlanPending    = "pending"
	PlanInProgress = "in_progress"
	PlanCompleted  = "completed"
)

// Result error codes.
const (
	ErrCodeInvalid        = "invalid"
	ErrCodeUnsupported    = "unsupported"
	ErrCodeBusy           = "busy"
	ErrCodeNotFound       = "not_found"
	ErrCodeAgent          = "agent_error"
	ErrCodePermissionGone = "permission_gone"
)

// Cursor is the last change a view applied.
type Cursor struct {
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
}

// ClientMessage is a view-to-process frame: hello, command, ping or pong.
type ClientMessage struct {
	V       int      `json:"v"`
	Type    string   `json:"type"`
	Client  string   `json:"client,omitempty"`
	Cursor  *Cursor  `json:"cursor,omitempty"`
	ID      string   `json:"id,omitempty"`
	Command *Command `json:"command,omitempty"`
}

// Validate checks the envelope and the payload for its type.
func (m ClientMessage) Validate() error {
	if m.V != Version {
		return fmt.Errorf("unsupported protocol version %d", m.V)
	}
	switch m.Type {
	case TypeHello:
		if m.Cursor == nil {
			return nil
		}
		if m.Cursor.Epoch == "" {
			return errors.New("hello cursor has an empty epoch")
		}
		if m.Cursor.Seq < 0 {
			return errors.New("hello cursor has a negative seq")
		}
		return nil
	case TypeCommand:
		if m.ID == "" {
			return errors.New("command has an empty id")
		}
		if m.Command == nil {
			return errors.New("command frame has no command")
		}
		return m.Command.Validate()
	case TypePing, TypePong:
		return nil
	default:
		return fmt.Errorf("unknown client message type %q", m.Type)
	}
}

// ServerMessage is a process-to-view frame: welcome, snapshot, changes,
// result, ping or pong.
type ServerMessage struct {
	V       int      `json:"v"`
	Type    string   `json:"type"`
	Epoch   string   `json:"epoch,omitempty"`
	Seq     int64    `json:"seq,omitempty"`
	State   *State   `json:"state,omitempty"`
	Changes []Change `json:"changes,omitempty"`
	ID      string   `json:"id,omitempty"`
	OK      *bool    `json:"ok,omitempty"`
	Error   *Error   `json:"error,omitempty"`
}

// Validate checks the envelope and the payload for its type.
func (m ServerMessage) Validate() error {
	if m.V != Version {
		return fmt.Errorf("unsupported protocol version %d", m.V)
	}
	switch m.Type {
	case TypeWelcome:
		return validateEpochSeq("welcome", m.Epoch, m.Seq)
	case TypeSnapshot:
		if err := validateEpochSeq("snapshot", m.Epoch, m.Seq); err != nil {
			return err
		}
		if m.State == nil {
			return errors.New("snapshot has no state")
		}
		return nil
	case TypeChanges:
		if err := validateEpochSeq("changes", m.Epoch, m.Seq); err != nil {
			return err
		}
		if m.Changes == nil {
			return errors.New("changes frame has no changes")
		}
		for i := range m.Changes {
			if err := m.Changes[i].Validate(); err != nil {
				return fmt.Errorf("change %d: %w", i, err)
			}
		}
		return nil
	case TypeResult:
		if m.ID == "" {
			return errors.New("result has an empty id")
		}
		if m.OK == nil {
			return errors.New("result has no ok flag")
		}
		if *m.OK {
			return nil
		}
		if m.Error == nil {
			return errors.New("failed result has no error")
		}
		return m.Error.Validate()
	case TypePing, TypePong:
		return nil
	default:
		return fmt.Errorf("unknown server message type %q", m.Type)
	}
}

func validateEpochSeq(kind, epoch string, seq int64) error {
	if epoch == "" {
		return fmt.Errorf("%s has an empty epoch", kind)
	}
	if seq < 0 {
		return fmt.Errorf("%s has a negative seq", kind)
	}
	return nil
}

// Error is a failed command result.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Validate checks that the error carries a code and a message.
func (e Error) Validate() error {
	if e.Code == "" {
		return errors.New("error has an empty code")
	}
	if e.Message == "" {
		return errors.New("error has an empty message")
	}
	return nil
}

// Change is one atomic list of ops, numbered in the process epoch.
type Change struct {
	Seq int64 `json:"seq"`
	Ops []Op  `json:"ops"`
}

// Validate checks every op in the change.
func (c Change) Validate() error {
	if c.Seq < 0 {
		return errors.New("change has a negative seq")
	}
	for i := range c.Ops {
		if err := c.Ops[i].Validate(); err != nil {
			return fmt.Errorf("op %d: %w", i, err)
		}
	}
	return nil
}

// Command is the payload of a command frame.
type Command struct {
	Kind        string       `json:"kind"`
	Text        string       `json:"text,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	RequestID   string       `json:"request_id,omitempty"`
	OptionID    string       `json:"option_id,omitempty"`
	ModeID      string       `json:"mode_id,omitempty"`
	Value       string       `json:"value,omitempty"`
	QueueID     string       `json:"queue_id,omitempty"`
	Enabled     *bool        `json:"enabled,omitempty"`
}

// Validate checks the required fields for the command kind.
func (c Command) Validate() error {
	switch c.Kind {
	case CommandPrompt:
		if c.Text == "" && len(c.Attachments) == 0 {
			return errors.New("prompt has neither text nor attachments")
		}
		if len(c.Text) > MaxLineBytes {
			return errors.New("prompt text exceeds 4 MiB")
		}
		for i := range c.Attachments {
			if err := c.Attachments[i].validate(); err != nil {
				return fmt.Errorf("attachment %d: %w", i, err)
			}
		}
		return nil
	case CommandCancel:
		return nil
	case CommandAnswer:
		if c.RequestID == "" {
			return errors.New("answer has an empty request_id")
		}
		if c.OptionID == "" {
			return errors.New("answer has an empty option_id")
		}
		return nil
	case CommandSetMode:
		if c.ModeID == "" {
			return errors.New("set_mode has an empty mode_id")
		}
		return nil
	case CommandSetOption:
		if c.OptionID == "" {
			return errors.New("set_option has an empty option_id")
		}
		return nil
	case CommandUnqueue:
		if c.QueueID == "" {
			return errors.New("unqueue has an empty queue_id")
		}
		return nil
	case CommandSetAutoAccept:
		if c.Enabled == nil {
			return errors.New("set_auto_accept has no enabled flag")
		}
		return nil
	default:
		return fmt.Errorf("unknown command kind %q", c.Kind)
	}
}

// Attachment is an image or file sent with a prompt.
type Attachment struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	Data string `json:"data"`
}

func (a Attachment) validate() error {
	if a.Name == "" {
		return errors.New("attachment has an empty name")
	}
	if a.Mime == "" {
		return errors.New("attachment has an empty mime")
	}
	if base64.StdEncoding.DecodedLen(len(a.Data)) > MaxAttachmentBytes {
		return errors.New("attachment exceeds 8 MiB")
	}
	if _, err := base64.StdEncoding.DecodeString(a.Data); err != nil {
		return errors.New("attachment data is not base64")
	}
	return nil
}

// State is the full transcript a snapshot carries and changes mutate.
// Entries are ordered oldest first.
type State struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Agent      string         `json:"agent"`
	Status     string         `json:"status"`
	Entries    []Entry        `json:"entries"`
	Permission *Permission    `json:"permission"`
	Plan       []PlanItem     `json:"plan"`
	Modes      []Mode         `json:"modes"`
	Mode       string         `json:"mode"`
	Options    []Option       `json:"options"`
	Queue      []QueuedPrompt `json:"queue"`
	AutoAccept bool           `json:"auto_accept"`
	Usage      *Usage         `json:"usage"`
	Error      string         `json:"error"`
}

// Entry is one transcript row. ID is stable for the life of the entry.
type Entry struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	Streaming bool   `json:"streaming"`
	Level     string `json:"level,omitempty"`
	Tool      *Tool  `json:"tool,omitempty"`
	At        int64  `json:"at"`
}

// Validate checks the required entry fields.
func (e Entry) Validate() error {
	if e.ID == "" {
		return errors.New("entry has an empty id")
	}
	if !validEntryKind(e.Kind) {
		return fmt.Errorf("unknown entry kind %q", e.Kind)
	}
	if len(e.Text) > MaxLineBytes {
		return errors.New("entry text exceeds 4 MiB")
	}
	return nil
}

// Tool is a tool call rendered inside a tool entry.
type Tool struct {
	Title     string        `json:"title"`
	Kind      string        `json:"kind"`
	Status    string        `json:"status"`
	Content   []ToolContent `json:"content"`
	Locations []string      `json:"locations"`
}

// ToolContent is one text or diff block of a tool call.
type ToolContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	Path string `json:"path,omitempty"`
	Old  string `json:"old,omitempty"`
	New  string `json:"new,omitempty"`
}

// Permission is the pending permission request, if any.
type Permission struct {
	ID         string             `json:"id"`
	Title      string             `json:"title"`
	ToolCallID string             `json:"tool_call_id"`
	Options    []PermissionOption `json:"options"`
}

// Validate checks that the request and its options are addressable.
func (p Permission) Validate() error {
	if p.ID == "" {
		return errors.New("permission has an empty id")
	}
	for i := range p.Options {
		if p.Options[i].ID == "" {
			return fmt.Errorf("permission option %d has an empty id", i)
		}
	}
	return nil
}

// PermissionOption is one answer offered by a permission request.
type PermissionOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// PlanItem is one step of the agent's plan.
type PlanItem struct {
	Content  string `json:"content"`
	Priority string `json:"priority"`
	Status   string `json:"status"`
}

func (p PlanItem) validate() error {
	if p.Content == "" {
		return errors.New("plan item has empty content")
	}
	if p.Priority != "" && !validPlanPriority(p.Priority) {
		return fmt.Errorf("unknown plan priority %q", p.Priority)
	}
	if p.Status != "" && !validPlanStatus(p.Status) {
		return fmt.Errorf("unknown plan status %q", p.Status)
	}
	return nil
}

// Mode is one ACP session mode.
type Mode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Option is one ACP select option, such as model or effort.
type Option struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Category     string         `json:"category"`
	CurrentValue string         `json:"current_value"`
	Choices      []OptionChoice `json:"choices"`
}

// OptionChoice is one selectable value of an option.
type OptionChoice struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// QueuedPrompt is a prompt waiting behind the active turn.
type QueuedPrompt struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// Usage is the agent's reported context and cost.
type Usage struct {
	Used    int64   `json:"used"`
	Size    int64   `json:"size"`
	CostUSD float64 `json:"cost_usd"`
}

// Op is one transcript mutation. Only the fields named by Op are read, and
// payload fields use omitempty; a missing field and an explicit null both
// mean the zero value (set_permission treats both as a clear).
type Op struct {
	Op         string         `json:"op"`
	Entry      *Entry         `json:"entry,omitempty"`
	ID         string         `json:"id,omitempty"`
	Text       string         `json:"text,omitempty"`
	Streaming  *bool          `json:"streaming,omitempty"`
	Status     string         `json:"status,omitempty"`
	Permission *Permission    `json:"permission,omitempty"`
	Plan       []PlanItem     `json:"plan,omitempty"`
	Modes      []Mode         `json:"modes,omitempty"`
	Mode       string         `json:"mode,omitempty"`
	Options    []Option       `json:"options,omitempty"`
	Queue      []QueuedPrompt `json:"queue,omitempty"`
	Enabled    *bool          `json:"enabled,omitempty"`
	Title      string         `json:"title,omitempty"`
	Usage      *Usage         `json:"usage,omitempty"`
	Error      string         `json:"error,omitempty"`
}

// Validate checks the op name and the payload required by it.
func (o Op) Validate() error {
	switch o.Op {
	case OpAppendEntry, OpSetEntry:
		if o.Entry == nil {
			return fmt.Errorf("%s has no entry", o.Op)
		}
		return o.Entry.Validate()
	case OpAppendText:
		if o.ID == "" {
			return errors.New("append_text has an empty id")
		}
		if len(o.Text) > MaxLineBytes {
			return errors.New("append_text text exceeds 4 MiB")
		}
		return nil
	case OpSetStreaming:
		if o.ID == "" {
			return errors.New("set_streaming has an empty id")
		}
		if o.Streaming == nil {
			return errors.New("set_streaming has no streaming flag")
		}
		return nil
	case OpRemoveEntry:
		if o.ID == "" {
			return errors.New("remove_entry has an empty id")
		}
		return nil
	case OpSetStatus:
		if !validStatus(o.Status) {
			return fmt.Errorf("unknown status %q", o.Status)
		}
		return nil
	case OpSetPermission:
		if o.Permission == nil {
			return nil
		}
		return o.Permission.Validate()
	case OpSetPlan:
		for i := range o.Plan {
			if err := o.Plan[i].validate(); err != nil {
				return fmt.Errorf("plan item %d: %w", i, err)
			}
		}
		return nil
	case OpSetModes:
		for i := range o.Modes {
			if o.Modes[i].ID == "" {
				return fmt.Errorf("mode %d has an empty id", i)
			}
		}
		return nil
	case OpSetOptions:
		for i := range o.Options {
			if o.Options[i].ID == "" {
				return fmt.Errorf("option %d has an empty id", i)
			}
		}
		return nil
	case OpSetQueue:
		for i := range o.Queue {
			if o.Queue[i].ID == "" {
				return fmt.Errorf("queued prompt %d has an empty id", i)
			}
			if len(o.Queue[i].Text) > MaxLineBytes {
				return fmt.Errorf("queued prompt %d text exceeds 4 MiB", i)
			}
		}
		return nil
	case OpSetAutoAccept:
		if o.Enabled == nil {
			return errors.New("set_auto_accept has no enabled flag")
		}
		return nil
	case OpSetTitle:
		return nil
	case OpSetUsage:
		if o.Usage == nil {
			return errors.New("set_usage has no usage")
		}
		return nil
	case OpSetError:
		return nil
	default:
		return fmt.Errorf("unknown op %q", o.Op)
	}
}

func validStatus(status string) bool {
	switch status {
	case StatusStarting, StatusIdle, StatusWorking, StatusBlocked, StatusExited:
		return true
	default:
		return false
	}
}

func validEntryKind(kind string) bool {
	switch kind {
	case KindUser, KindAgent, KindThought, KindTool, KindNotice:
		return true
	default:
		return false
	}
}

func validPlanPriority(priority string) bool {
	switch priority {
	case PriorityHigh, PriorityMedium, PriorityLow:
		return true
	default:
		return false
	}
}

func validPlanStatus(status string) bool {
	switch status {
	case PlanPending, PlanInProgress, PlanCompleted:
		return true
	default:
		return false
	}
}
