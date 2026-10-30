package acp

import (
	"encoding/json"
	"fmt"
)

// InitializeResult is the agent's reply to initialize.
type InitializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities"`
	AgentInfo         *AgentInfo        `json:"agentInfo,omitempty"`
	AuthMethods       []AuthMethod      `json:"authMethods,omitempty"`
}

type AgentCapabilities struct {
	LoadSession        bool               `json:"loadSession,omitempty"`
	PromptCapabilities PromptCapabilities `json:"promptCapabilities,omitempty"`
	MCPCapabilities    MCPCapabilities    `json:"mcpCapabilities,omitempty"`
}

type PromptCapabilities struct {
	Image           bool `json:"image,omitempty"`
	Audio           bool `json:"audio,omitempty"`
	EmbeddedContext bool `json:"embeddedContext,omitempty"`
}

type MCPCapabilities struct {
	HTTP bool `json:"http,omitempty"`
	SSE  bool `json:"sse,omitempty"`
}

type AgentInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version,omitempty"`
}

type AuthMethod struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// Session is the result of session/new or session/load.
type Session struct {
	SessionID     string         `json:"sessionId"`
	Modes         *SessionModes  `json:"modes,omitempty"`
	ConfigOptions []ConfigOption `json:"configOptions,omitempty"`
}

type SessionModes struct {
	CurrentModeID  string `json:"currentModeId"`
	AvailableModes []Mode `json:"availableModes"`
}

type Mode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ConfigOption is one model, effort or other adapter setting. CurrentValue is
// a string for select options and a bool for boolean options.
type ConfigOption struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Description  string              `json:"description,omitempty"`
	Category     string              `json:"category,omitempty"`
	Type         string              `json:"type"`
	CurrentValue any                 `json:"currentValue,omitempty"`
	Options      []ConfigOptionValue `json:"options,omitempty"`
}

type ConfigOptionValue struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// PromptResult closes one turn.
type PromptResult struct {
	StopReason string `json:"stopReason"`
	Usage      *Usage `json:"usage,omitempty"`
}

type Usage struct {
	InputTokens       int `json:"inputTokens,omitempty"`
	OutputTokens      int `json:"outputTokens,omitempty"`
	TotalTokens       int `json:"totalTokens,omitempty"`
	ThoughtTokens     int `json:"thoughtTokens,omitempty"`
	CachedReadTokens  int `json:"cachedReadTokens,omitempty"`
	CachedWriteTokens int `json:"cachedWriteTokens,omitempty"`
}

// ContentBlock is one prompt block. Only text and image blocks are built by
// this client; anything else parsed from the agent is kept in Raw.
type ContentBlock struct {
	Type     string
	Text     string
	MimeType string
	Data     string
	Raw      json.RawMessage
}

// TextBlock is a text content block. An empty text is sent as "".
func TextBlock(text string) ContentBlock {
	return ContentBlock{Type: "text", Text: text}
}

// ImageBlock is a base64 image content block.
func ImageBlock(mimeType, data string) ContentBlock {
	return ContentBlock{Type: "image", MimeType: mimeType, Data: data}
}

func (b ContentBlock) MarshalJSON() ([]byte, error) {
	switch b.Type {
	case "text":
		return json.Marshal(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{Type: "text", Text: b.Text})
	case "image":
		return json.Marshal(struct {
			Type     string `json:"type"`
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
		}{Type: "image", MimeType: b.MimeType, Data: b.Data})
	}
	if len(b.Raw) > 0 {
		return b.Raw, nil
	}
	return nil, fmt.Errorf("acp: unsupported content block type %q", b.Type)
}

func (b *ContentBlock) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	b.Type = wire.Type
	switch wire.Type {
	case "text":
		b.Text = wire.Text
	case "image":
		b.MimeType = wire.MimeType
		b.Data = wire.Data
	default:
		b.Raw = append(json.RawMessage(nil), data...)
	}
	return nil
}

// ToolCall is a tool_call or tool_call_update payload. An update may carry
// only the fields that changed; ToolCallID is always present.
type ToolCall struct {
	ToolCallID string          `json:"toolCallId"`
	Title      string          `json:"title,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	Status     string          `json:"status,omitempty"`
	Content    []ToolContent   `json:"content,omitempty"`
	Locations  []ToolLocation  `json:"locations,omitempty"`
	RawInput   json.RawMessage `json:"rawInput,omitempty"`
	RawOutput  json.RawMessage `json:"rawOutput,omitempty"`
}

type ToolLocation struct {
	Path string `json:"path"`
	Line *int   `json:"line,omitempty"`
}

// ToolContent is one tool result block. Text and diff blocks are modelled;
// every other variant stays in Raw.
type ToolContent struct {
	Type string
	Text string
	Diff *ToolDiff
	Raw  json.RawMessage
}

type ToolDiff struct {
	Path    string `json:"path"`
	OldText string `json:"oldText,omitempty"`
	NewText string `json:"newText"`
}

func (c *ToolContent) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type    string          `json:"type"`
		Text    string          `json:"text"`
		Path    string          `json:"path"`
		OldText string          `json:"oldText"`
		NewText string          `json:"newText"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	switch wire.Type {
	case "text":
		c.Type = "text"
		c.Text = wire.Text
	case "content":
		// A tool content wrapper around a text content block.
		var block ContentBlock
		if err := json.Unmarshal(wire.Content, &block); err == nil && block.Type == "text" {
			c.Type = "text"
			c.Text = block.Text
			return nil
		}
		c.Raw = append(json.RawMessage(nil), data...)
	case "diff":
		c.Type = "diff"
		c.Diff = &ToolDiff{Path: wire.Path, OldText: wire.OldText, NewText: wire.NewText}
	default:
		c.Raw = append(json.RawMessage(nil), data...)
	}
	return nil
}

// PlanEntry is one step of an ACP plan.
type PlanEntry struct {
	Content  string `json:"content"`
	Priority string `json:"priority"`
	Status   string `json:"status"`
}

// UsageUpdate reports context usage for the current session.
type UsageUpdate struct {
	Used int   `json:"used"`
	Size int   `json:"size"`
	Cost *Cost `json:"cost,omitempty"`
}

type Cost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// AvailableCommand is one slash command the adapter offers.
type AvailableCommand struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	Input       *AvailableCommandInput `json:"input,omitempty"`
}

type AvailableCommandInput struct {
	Hint string `json:"hint,omitempty"`
}

// UpdateKind names one session/update variant. UpdateUnknown is the local
// fallback for a variant this client does not model.
type UpdateKind string

const (
	UpdateUserMessageChunk  UpdateKind = "user_message_chunk"
	UpdateAgentMessageChunk UpdateKind = "agent_message_chunk"
	UpdateAgentThoughtChunk UpdateKind = "agent_thought_chunk"
	UpdateToolCall          UpdateKind = "tool_call"
	UpdateToolCallUpdate    UpdateKind = "tool_call_update"
	UpdatePlan              UpdateKind = "plan"
	UpdateCurrentMode       UpdateKind = "current_mode_update"
	UpdateConfigOption      UpdateKind = "config_option_update"
	UpdateUsage             UpdateKind = "usage_update"
	UpdateAvailableCommands UpdateKind = "available_commands_update"
	UpdateUnknown           UpdateKind = "unknown"
)

// Update is one decoded session/update. Only the fields for Kind are set. Raw
// always holds the update object exactly as the agent sent it, which is the
// only content available for UpdateUnknown.
type Update struct {
	SessionID     string
	Kind          UpdateKind
	Content       ContentBlock
	MessageID     string
	ToolCall      *ToolCall
	Plan          []PlanEntry
	ModeID        string
	ConfigOptions []ConfigOption
	Usage         *UsageUpdate
	Commands      []AvailableCommand
	Raw           json.RawMessage
}

// parseUpdate decodes the "update" object of a session/update notification.
func parseUpdate(sessionID string, raw json.RawMessage) Update {
	update := Update{SessionID: sessionID, Raw: append(json.RawMessage(nil), raw...)}
	var probe struct {
		SessionUpdate UpdateKind `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		update.Kind = UpdateUnknown
		return update
	}
	update.Kind = probe.SessionUpdate
	switch probe.SessionUpdate {
	case UpdateUserMessageChunk, UpdateAgentMessageChunk, UpdateAgentThoughtChunk:
		var chunk struct {
			Content   ContentBlock `json:"content"`
			MessageID string       `json:"messageId"`
		}
		if json.Unmarshal(raw, &chunk) == nil {
			update.Content = chunk.Content
			update.MessageID = chunk.MessageID
		}
	case UpdateToolCall, UpdateToolCallUpdate:
		var call ToolCall
		if json.Unmarshal(raw, &call) == nil {
			update.ToolCall = &call
		}
	case UpdatePlan:
		var plan struct {
			Entries []PlanEntry `json:"entries"`
		}
		if json.Unmarshal(raw, &plan) == nil {
			update.Plan = plan.Entries
		}
	case UpdateCurrentMode:
		var mode struct {
			CurrentModeID string `json:"currentModeId"`
		}
		if json.Unmarshal(raw, &mode) == nil {
			update.ModeID = mode.CurrentModeID
		}
	case UpdateConfigOption:
		var options struct {
			ConfigOptions []ConfigOption `json:"configOptions"`
		}
		if json.Unmarshal(raw, &options) == nil {
			update.ConfigOptions = options.ConfigOptions
		}
	case UpdateUsage:
		var usage UsageUpdate
		if json.Unmarshal(raw, &usage) == nil {
			update.Usage = &usage
		}
	case UpdateAvailableCommands:
		var commands struct {
			AvailableCommands []AvailableCommand `json:"availableCommands"`
		}
		if json.Unmarshal(raw, &commands) == nil {
			update.Commands = commands.AvailableCommands
		}
	default:
		update.Kind = UpdateUnknown
	}
	return update
}

// PermissionRequest is an agent's session/request_permission call. RequestID
// is the JSON-RPC id to pass back to AnswerPermission.
type PermissionRequest struct {
	SessionID string             `json:"sessionId"`
	Options   []PermissionOption `json:"options"`
	ToolCall  *ToolCall          `json:"toolCall,omitempty"`
	RequestID string             `json:"-"`
}

type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// PermissionResponse answers a request with one selected option, or with the
// cancelled outcome when no option is selected.
type PermissionResponse struct {
	Outcome PermissionOutcome `json:"outcome"`
}

type PermissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

// EventKind tells which field of Event is set.
type EventKind int

const (
	EventUpdate EventKind = iota
	EventPermission
	EventExit
)

// Event is one item from the adapter: a session update, a permission request,
// or the end of the connection.
type Event struct {
	Kind       EventKind
	Update     *Update
	Permission *PermissionRequest
	Exit       *Exit
}

// Exit reports that the adapter connection ended. Err is ErrClosed after
// Close, the wait error for a failed process, or io.EOF for a clean end.
type Exit struct {
	Err    error
	Code   int
	Stderr string
}
