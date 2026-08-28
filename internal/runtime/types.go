package runtime

import (
	"context"
	"errors"
	"fmt"
)

// Runtime is the Harness seam. Callers describe the live harness, observe it,
// and execute typed Pairfob commands; Herdr method names never cross this seam.
type Runtime interface {
	Describe(context.Context, SessionRef) (Descriptor, error)
	Observe(context.Context, SessionRef, Query) (View, error)
	Execute(context.Context, SessionRef, string, Command) (Receipt, error)
}

// SessionRef selects a Herdr socket. An empty name selects the default socket.
// The name is never forwarded in a Herdr request.
type SessionRef struct {
	Name string `json:"name,omitempty"`
}

func DefaultSession() SessionRef          { return SessionRef{} }
func NamedSession(name string) SessionRef { return SessionRef{Name: name} }

type Feature string

const (
	FeatureSnapshot           Feature = "snapshot"
	FeaturePaneRead           Feature = "pane_read"
	FeaturePaneInput          Feature = "pane_input"
	FeatureRename             Feature = "rename"
	FeatureClose              Feature = "close"
	FeatureCreateConversation Feature = "create_conversation"
	FeatureCreateTab          Feature = "create_tab"
	FeatureSplitPane          Feature = "split_pane"
	FeaturePromptAgent        Feature = "prompt_agent"
	FeatureWorktreeList       Feature = "worktree_list"
	FeatureWorktreeCreate     Feature = "worktree_create"
	FeatureWorktreeOpen       Feature = "worktree_open"
	FeatureLayoutResize       Feature = "layout_resize"
	FeatureLayoutSwap         Feature = "layout_swap"
	FeatureLayoutZoom         Feature = "layout_zoom"
	FeatureHistory            Feature = "history"
)

type Capability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type AgentKind struct {
	Kind string `json:"kind"`
}

type Descriptor struct {
	Runtime      string                 `json:"runtime"`
	Version      string                 `json:"version,omitempty"`
	Protocol     int                    `json:"protocol,omitempty"`
	Capabilities map[Feature]Capability `json:"capabilities"`
	AgentKinds   []AgentKind            `json:"agent_kinds"`
	Warnings     []string               `json:"warnings,omitempty"`
}

func (d Descriptor) Supports(feature Feature) bool {
	capability, ok := d.Capabilities[feature]
	return ok && capability.Available
}

type Snapshot struct {
	HerdrVersion  string            `json:"herdr_version"`
	HerdrProtocol int               `json:"herdr_protocol"`
	Session       *string           `json:"session"`
	CapturedAt    int64             `json:"captured_at"`
	Focused       map[string]string `json:"focused"`
	Workspaces    []Workspace       `json:"workspaces"`
	Tabs          []Tab             `json:"tabs"`
	Panes         []Pane            `json:"panes"`
}

type Workspace struct {
	WorkspaceID string `json:"workspace_id"`
	Number      int    `json:"number"`
	Label       string `json:"label"`
	Cwd         string `json:"cwd"`
	AgentStatus string `json:"agent_status"`
}

type Tab struct {
	TabID       string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
	Label       string `json:"label"`
}

type AgentSessionRef struct {
	Source string
	Agent  string
	Kind   string
	Value  string
}

type Pane struct {
	PaneID      string  `json:"pane_id"`
	WorkspaceID string  `json:"workspace_id"`
	TabID       string  `json:"tab_id"`
	Cwd         string  `json:"cwd"`
	Agent       string  `json:"agent"`
	AgentStatus string  `json:"agent_status"`
	Label       *string `json:"label"`
	// TerminalTitle is the stripped PTY OSC title. Display-only; it is not a user-assigned name.
	TerminalTitle    string `json:"terminal_title,omitempty"`
	HistoryAvailable bool   `json:"history_available"`
	// AgentSession is trusted runtime state for transcript adapters. It must
	// never be serialized to a Web client.
	AgentSession *AgentSessionRef `json:"-"`
	Scroll       *struct {
		OffsetFromBottom int `json:"offset_from_bottom"`
		ViewportRows     int `json:"viewport_rows"`
	} `json:"scroll"`
	VisibleText string `json:"-"`
}

type Query interface{ runtimeQuery() }
type View interface{ runtimeView() }

type SnapshotQuery struct{}

func (SnapshotQuery) runtimeQuery() {}

type PaneReadQuery struct {
	PaneID string
	Source string
	Format string
	Lines  int
}

func (PaneReadQuery) runtimeQuery() {}

type HistoryQuery struct {
	PaneID string
	Cursor *string
	Limit  int
}

func (HistoryQuery) runtimeQuery() {}

type WorktreeListQuery struct {
	WorkspaceID string
	CWD         string
}

func (WorktreeListQuery) runtimeQuery() {}

type SnapshotView struct{ Snapshot Snapshot }

func (SnapshotView) runtimeView() {}

type PaneReadView struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

func (PaneReadView) runtimeView() {}

type HistoryItem struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type HistoryView struct {
	Items     []HistoryItem `json:"items"`
	Cursor    *string       `json:"cursor"`
	Truncated bool          `json:"truncated"`
}

func (HistoryView) runtimeView() {}

type Worktree struct {
	Path            string  `json:"path"`
	Branch          *string `json:"branch,omitempty"`
	Label           string  `json:"label"`
	OpenWorkspaceID *string `json:"open_workspace_id,omitempty"`
	Bare            bool    `json:"is_bare"`
	Detached        bool    `json:"is_detached"`
	Prunable        bool    `json:"is_prunable"`
	Linked          bool    `json:"is_linked_worktree"`
}

type WorktreeSource struct {
	RepositoryKey   string `json:"repo_key"`
	RepositoryName  string `json:"repo_name"`
	RepositoryRoot  string `json:"repo_root"`
	SourcePath      string `json:"source_checkout_path"`
	SourceWorkspace string `json:"source_workspace_id,omitempty"`
}

type WorktreeListView struct {
	Source    WorktreeSource `json:"source"`
	Worktrees []Worktree     `json:"worktrees"`
}

func (WorktreeListView) runtimeView() {}

type Command interface{ runtimeCommand() }

type SendTextCommand struct {
	PaneID string
	Text   string
}

func (SendTextCommand) runtimeCommand() {}

type SendKeysCommand struct {
	PaneID string
	Keys   []string
}

func (SendKeysCommand) runtimeCommand() {}

type RenamePaneCommand struct {
	PaneID string
	Label  *string
}

func (RenamePaneCommand) runtimeCommand() {}

type RenameTabCommand struct {
	TabID string
	Label string
}

func (RenameTabCommand) runtimeCommand() {}

type RenameWorkspaceCommand struct {
	WorkspaceID string
	Label       string
}

func (RenameWorkspaceCommand) runtimeCommand() {}

type ClosePaneCommand struct{ PaneID string }

func (ClosePaneCommand) runtimeCommand() {}

type CloseTabCommand struct{ TabID string }

func (CloseTabCommand) runtimeCommand() {}

type CreateConversationCommand struct {
	CWD   string
	Label string
	// AgentKind selects a live Herdr agent. Empty creates a terminal workspace
	// and does not call agent.start.
	AgentKind string
	AgentName string
}

func (CreateConversationCommand) runtimeCommand() {}

type CreateTabCommand struct {
	WorkspaceID string
	CWD         string
	Label       string
}

func (CreateTabCommand) runtimeCommand() {}

type SplitDirection string

const (
	SplitRight SplitDirection = "right"
	SplitDown  SplitDirection = "down"
)

type SplitPaneCommand struct {
	WorkspaceID  string
	TargetPaneID string
	CWD          string
	Direction    SplitDirection
	Ratio        *float64
}

func (SplitPaneCommand) runtimeCommand() {}

type PromptAgentCommand struct {
	Target string
	Text   string
}

func (PromptAgentCommand) runtimeCommand() {}

type WorktreeCreateCommand struct {
	WorkspaceID string
	CWD         string
	Branch      string
	Base        string
	Path        string
	Label       string
}

func (WorktreeCreateCommand) runtimeCommand() {}

type WorktreeOpenCommand struct {
	WorkspaceID string
	CWD         string
	Branch      string
	Path        string
	Label       string
}

func (WorktreeOpenCommand) runtimeCommand() {}

type PaneDirection string

const (
	PaneLeft  PaneDirection = "left"
	PaneRight PaneDirection = "right"
	PaneUp    PaneDirection = "up"
	PaneDown  PaneDirection = "down"
)

type ResizePaneCommand struct {
	PaneID    string
	Direction PaneDirection
	Amount    *float64
}

func (ResizePaneCommand) runtimeCommand() {}

type SwapPaneCommand struct {
	PaneID    string
	Direction PaneDirection
}

func (SwapPaneCommand) runtimeCommand() {}

type ZoomMode string

const (
	ZoomToggle ZoomMode = "toggle"
	ZoomOn     ZoomMode = "on"
	ZoomOff    ZoomMode = "off"
)

type ZoomPaneCommand struct {
	PaneID string
	Mode   ZoomMode
}

func (ZoomPaneCommand) runtimeCommand() {}

type EntityKind string

const (
	EntityWorkspace EntityKind = "workspace"
	EntityTab       EntityKind = "tab"
	EntityPane      EntityKind = "pane"
	EntityAgent     EntityKind = "agent"
	EntityWorktree  EntityKind = "worktree"
)

type EntityRef struct {
	Kind EntityKind `json:"kind"`
	ID   string     `json:"id"`
}

type Outcome string

const (
	OutcomeNotApplied Outcome = "not_applied"
	OutcomeApplied    Outcome = "applied"
	OutcomeNoop       Outcome = "noop"
	OutcomePartial    Outcome = "partial"
	OutcomeUnknown    Outcome = "unknown"
)

type Receipt struct {
	OperationID string      `json:"operation_id"`
	Outcome     Outcome     `json:"outcome"`
	Created     []EntityRef `json:"created,omitempty"`
	Updated     []EntityRef `json:"updated,omitempty"`
	Removed     []EntityRef `json:"removed,omitempty"`
}

type ErrorCode string

const (
	CodeUnsupported ErrorCode = "unsupported"
	CodeInvalid     ErrorCode = "invalid"
	CodeKey         ErrorCode = "invalid_key"
	CodeNotFound    ErrorCode = "not_found"
	CodeStale       ErrorCode = "stale"
	CodeConflict    ErrorCode = "conflict"
	CodeBlocked     ErrorCode = "blocked"
	CodeNotReady    ErrorCode = "not_ready"
	CodeOffline     ErrorCode = "offline"
	CodeTimeout     ErrorCode = "timeout"
	CodeRateLimited ErrorCode = "rate_limited"
	CodeInternal    ErrorCode = "internal"
)

type RetryAdvice string

const (
	RetryReadSafe RetryAdvice = "read_safe"
	RetryUserOnly RetryAdvice = "user_only"
	RetryNever    RetryAdvice = "never"
)

type Fault struct {
	Code        ErrorCode   `json:"code"`
	Operation   string      `json:"operation,omitempty"`
	Target      *EntityRef  `json:"target,omitempty"`
	Outcome     Outcome     `json:"outcome"`
	Retry       RetryAdvice `json:"retry"`
	SafeMessage string      `json:"message"`
	Cause       error       `json:"-"`
}

func (f *Fault) Error() string {
	if f == nil {
		return ""
	}
	if f.SafeMessage != "" {
		return f.SafeMessage
	}
	return string(f.Code)
}

func (f *Fault) Unwrap() error {
	if f == nil {
		return nil
	}
	return f.Cause
}

func AsFault(err error) (*Fault, bool) {
	var fault *Fault
	ok := errors.As(err, &fault)
	return fault, ok
}

func unsupported(operation, message string) error {
	if message == "" {
		message = fmt.Sprintf("%s is unsupported", operation)
	}
	return &Fault{Code: CodeUnsupported, Operation: operation, Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: message}
}

const (
	SourceVisible         = "visible"
	SourceRecent          = "recent"
	SourceRecentUnwrapped = "recent_unwrapped"
	FormatText            = "text"
	FormatANSI            = "ansi"
)
