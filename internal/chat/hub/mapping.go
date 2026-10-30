package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

// sessionSettings converts a new session into transcript modes and options.
func sessionSettings(session acp.Session) ([]protocol.Mode, string, []protocol.Option) {
	modes := []protocol.Mode{}
	mode := ""
	if session.Modes != nil {
		mode = session.Modes.CurrentModeID
		for _, available := range session.Modes.AvailableModes {
			if available.ID == "" {
				continue
			}
			modes = append(modes, protocol.Mode{
				ID:          available.ID,
				Name:        available.Name,
				Description: available.Description,
			})
		}
	}
	return modes, mode, optionsFromACP(session.ConfigOptions)
}

// optionsFromACP converts select config options. Values are strings on the
// pairfob-chat.v1 wire, so a boolean option becomes "true" or "false".
func optionsFromACP(configOptions []acp.ConfigOption) []protocol.Option {
	options := make([]protocol.Option, 0, len(configOptions))
	for _, config := range configOptions {
		if config.ID == "" {
			continue
		}
		option := protocol.Option{
			ID:           config.ID,
			Name:         config.Name,
			Category:     config.Category,
			CurrentValue: optionValue(config.CurrentValue),
			Choices:      make([]protocol.OptionChoice, 0, len(config.Options)),
		}
		for _, choice := range config.Options {
			option.Choices = append(option.Choices, protocol.OptionChoice{
				Value:       choice.Value,
				Name:        choice.Name,
				Description: choice.Description,
			})
		}
		options = append(options, option)
	}
	return options
}

// mergeOptions replaces matching options and keeps the rest. Adapters send
// either the full option list or only the changed option; a merge covers both.
func mergeOptions(current, updates []protocol.Option) []protocol.Option {
	merged := make([]protocol.Option, 0, len(current)+len(updates))
	merged = append(merged, current...)
	for _, update := range updates {
		index := slices.IndexFunc(merged, func(option protocol.Option) bool { return option.ID == update.ID })
		if index < 0 {
			merged = append(merged, update)
			continue
		}
		merged[index] = update
	}
	return merged
}

func optionValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return fmt.Sprintf("%v", typed)
	default:
		data, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return string(data)
	}
}

// toolFromACP builds the tool payload of a new tool entry.
func toolFromACP(call *acp.ToolCall) protocol.Tool {
	return protocol.Tool{
		Title:     call.Title,
		Kind:      call.Kind,
		Status:    call.Status,
		Content:   toolContentFromACP(call.Content),
		Locations: toolLocationsFromACP(call.Locations),
	}
}

func toolContentFromACP(content []acp.ToolContent) []protocol.ToolContent {
	converted := make([]protocol.ToolContent, 0, len(content))
	for _, block := range content {
		switch block.Type {
		case "text":
			converted = append(converted, protocol.ToolContent{Type: "text", Text: block.Text})
		case "diff":
			if block.Diff == nil {
				continue
			}
			converted = append(converted, protocol.ToolContent{
				Type: "diff",
				Path: block.Diff.Path,
				Old:  block.Diff.OldText,
				New:  block.Diff.NewText,
			})
		}
	}
	return converted
}

func toolLocationsFromACP(locations []acp.ToolLocation) []string {
	converted := make([]string, 0, len(locations))
	for _, location := range locations {
		if location.Path != "" {
			converted = append(converted, location.Path)
		}
	}
	return converted
}

func planFromACP(entries []acp.PlanEntry) []protocol.PlanItem {
	items := make([]protocol.PlanItem, 0, len(entries))
	for _, entry := range entries {
		if entry.Content == "" {
			continue
		}
		items = append(items, protocol.PlanItem{
			Content:  entry.Content,
			Priority: planPriority(entry.Priority),
			Status:   planStatus(entry.Status),
		})
	}
	return items
}

// planPriority and planStatus drop values the frozen schema does not know,
// keeping the entry rather than rejecting the whole plan.
func planPriority(priority string) string {
	switch priority {
	case protocol.PriorityHigh, protocol.PriorityMedium, protocol.PriorityLow:
		return priority
	default:
		return ""
	}
}

func planStatus(status string) string {
	switch status {
	case protocol.PlanPending, protocol.PlanInProgress, protocol.PlanCompleted:
		return status
	default:
		return ""
	}
}

func permissionFromACP(request *acp.PermissionRequest) protocol.Permission {
	permission := protocol.Permission{
		ID:      request.RequestID,
		Title:   "Permission required",
		Options: make([]protocol.PermissionOption, 0, len(request.Options)),
	}
	if request.ToolCall != nil {
		permission.ToolCallID = request.ToolCall.ToolCallID
		if request.ToolCall.Title != "" {
			permission.Title = request.ToolCall.Title
		}
	}
	for _, option := range request.Options {
		if option.OptionID == "" {
			continue
		}
		permission.Options = append(permission.Options, protocol.PermissionOption{
			ID:   option.OptionID,
			Name: option.Name,
			Kind: option.Kind,
		})
	}
	return permission
}

// allowOption picks the option an automatic policy should answer with.
func allowOption(options []protocol.PermissionOption) (string, bool) {
	for _, option := range options {
		if option.Kind == "allow_once" {
			return option.ID, true
		}
	}
	for _, option := range options {
		if strings.HasPrefix(option.Kind, "allow") {
			return option.ID, true
		}
	}
	return "", false
}

// promptBlocks forwards the prompt text and image attachments. Other
// attachment kinds stay local to the view that sent them.
func promptBlocks(text string, attachments []protocol.Attachment) ([]acp.ContentBlock, error) {
	blocks := make([]acp.ContentBlock, 0, len(attachments)+1)
	if text != "" {
		blocks = append(blocks, acp.TextBlock(text))
	}
	for _, attachment := range attachments {
		if !strings.HasPrefix(attachment.Mime, "image/") {
			continue
		}
		if attachment.Data == "" {
			return nil, fmt.Errorf("attachment %q has no data", attachment.Name)
		}
		blocks = append(blocks, acp.ImageBlock(attachment.Mime, attachment.Data))
	}
	if len(blocks) == 0 {
		return nil, errors.New("prompt has no text or image content for the agent")
	}
	return blocks, nil
}

func clonePermission(permission *protocol.Permission) *protocol.Permission {
	if permission == nil {
		return nil
	}
	clone := *permission
	clone.Options = slices.Clone(permission.Options)
	return &clone
}
