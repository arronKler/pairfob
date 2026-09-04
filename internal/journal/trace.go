package journal

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Event is one step on the agent execution timeline.
type Event struct {
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	Name   string `json:"name,omitempty"`
	Input  string `json:"input,omitempty"`
	Output string `json:"output,omitempty"`
}

type TracePage struct {
	Items      []Event `json:"items"`
	NextCursor *string `json:"next_cursor"`
	Truncated  bool    `json:"truncated"`
}

type parsedEvent struct {
	Event
	call       string
	mergeKey   string
	outputOnly bool
}

const (
	// Trace fields often contain shell output with many JSON escapes. Budget the
	// encoded event rather than its raw strings so one tool result can never make
	// the enclosing Pairfob response exceed the encrypted envelope limit.
	maxTraceEventBytes = 64 << 10
	maxTraceItemsBytes = maxPageItemsBytes
)

func eventSize(ev Event) int {
	encoded, err := json.Marshal(ev)
	if err != nil {
		return maxTraceItemsBytes + 1
	}
	return len(encoded)
}

func clipEvent(ev Event, truncated bool) (Event, bool) {
	return clipEventToLimit(ev, maxTraceEventBytes, truncated)
}

func clipEventToLimit(ev Event, limit int, truncated bool) (Event, bool) {
	ev.Text, truncated = clip(ev.Text, maxMessageBytes, truncated)
	ev.Input, truncated = clip(ev.Input, maxMessageBytes, truncated)
	ev.Output, truncated = clip(ev.Output, maxMessageBytes, truncated)
	for eventSize(ev) > limit {
		field := largestEventField(&ev)
		if field == nil {
			break
		}
		if len(*field) <= 4 {
			*field = ""
		} else {
			*field, _ = clip(*field, len(*field)/2, false)
		}
		truncated = true
	}
	return ev, truncated
}

func largestEventField(ev *Event) *string {
	fields := []*string{&ev.Text, &ev.Input, &ev.Output}
	var largest *string
	largestSize := 0
	for _, field := range fields {
		if *field == "" {
			continue
		}
		encoded, _ := json.Marshal(*field)
		if len(encoded) > largestSize {
			largest, largestSize = field, len(encoded)
		}
	}
	return largest
}

func compactJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if json.Unmarshal(raw, &asString) == nil {
		return asString
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err == nil {
		return buf.String()
	}
	return strings.TrimSpace(string(raw))
}

func flattenToolContent(raw json.RawMessage) string {
	return flattenToolContentAt(raw, true)
}

func flattenToolContentAt(raw json.RawMessage, fallback bool) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var asString string
	if json.Unmarshal(raw, &asString) == nil {
		return asString
	}
	var blocks []struct {
		Type    string          `json:"type"`
		Text    string          `json:"text"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		parts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			if block.Text != "" && (block.Type == "text" || block.Type == "input_text" || block.Type == "" || block.Type == "content") {
				parts = append(parts, block.Text)
			}
			if nested := flattenToolContentAt(block.Content, false); nested != "" {
				parts = append(parts, nested)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	var obj struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Text != "" {
		return obj.Text
	}
	if !fallback {
		return ""
	}
	return compactJSON(raw)
}

func visibleUserText(text string) string {
	parts := strings.Split(text, "\n\n")
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		s := strings.TrimSpace(part)
		switch {
		case s == "":
			continue
		case strings.HasPrefix(s, "<environment_context>"),
			strings.HasPrefix(s, "<user_instructions>"),
			strings.HasPrefix(s, "<developer_instructions>"),
			strings.HasPrefix(s, "<INSTRUCTIONS>"),
			strings.HasPrefix(s, "# AGENTS.md instructions"):
			continue
		default:
			kept = append(kept, part)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n\n"))
}

func grokToolName(title, metaName, kind string) string {
	for _, name := range []string{metaName, kind} {
		if toolName.MatchString(name) {
			return name
		}
	}
	if fields := strings.Fields(title); len(fields) > 0 && toolName.MatchString(fields[0]) {
		return fields[0]
	}
	return ""
}

func canMerge(window []parsedEvent, ev parsedEvent) bool {
	if ev.outputOnly || ev.mergeKey == "" || len(window) == 0 {
		return false
	}
	if ev.Type != "user" && ev.Type != "assistant" && ev.Type != "thinking" {
		return false
	}
	last := window[len(window)-1]
	return last.Type == ev.Type && last.mergeKey == ev.mergeKey && ev.Text != "" && last.Text != ""
}

func placeholderOutput(output string) bool {
	return output == "" || output == "完成" || output == "失败"
}

func outputTarget(window []parsedEvent, call, output string) (*parsedEvent, bool) {
	if output == "" {
		return nil, true
	}
	for i := len(window) - 1; i >= 0; i-- {
		item := &window[i]
		if item.Type != "tool" || !placeholderOutput(item.Output) {
			continue
		}
		if call != "" && item.call != "" && item.call != call {
			continue
		}
		return item, true
	}
	return nil, false
}

func parseCodexTrace(line []byte) []parsedEvent {
	var item struct {
		Type    string `json:"type"`
		Payload struct {
			Type      string          `json:"type"`
			Role      string          `json:"role"`
			Name      string          `json:"name"`
			CallID    string          `json:"call_id"`
			Arguments json.RawMessage `json:"arguments"`
			Input     json.RawMessage `json:"input"`
			Output    json.RawMessage `json:"output"`
			Content   []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Summary []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"summary"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &item) != nil || item.Type != "response_item" {
		return nil
	}
	switch item.Payload.Type {
	case "function_call", "custom_tool_call":
		if !toolName.MatchString(item.Payload.Name) {
			return nil
		}
		input := compactJSON(item.Payload.Arguments)
		if input == "" {
			input = compactJSON(item.Payload.Input)
		}
		return []parsedEvent{{
			Event: Event{Type: "tool", Name: item.Payload.Name, Input: input},
			call:  item.Payload.CallID,
		}}
	case "function_call_output", "custom_tool_call_output":
		output := flattenToolContent(item.Payload.Output)
		if output == "" {
			return nil
		}
		return []parsedEvent{{
			Event:      Event{Type: "tool", Output: output},
			call:       item.Payload.CallID,
			outputOnly: true,
		}}
	case "reasoning":
		parts := make([]string, 0, len(item.Payload.Content)+len(item.Payload.Summary))
		for _, content := range item.Payload.Content {
			if content.Text != "" {
				parts = append(parts, content.Text)
			}
		}
		for _, summary := range item.Payload.Summary {
			if summary.Text != "" {
				parts = append(parts, summary.Text)
			}
		}
		if len(parts) == 0 {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: "thinking", Text: strings.Join(parts, "\n")}}}
	case "message":
		if item.Payload.Role != "user" && item.Payload.Role != "assistant" {
			return nil
		}
		out := make([]parsedEvent, 0, 2)
		parts := make([]string, 0, len(item.Payload.Content))
		for _, content := range item.Payload.Content {
			if content.Text == "" {
				continue
			}
			if content.Type == "reasoning_text" {
				out = append(out, parsedEvent{Event: Event{Type: "thinking", Text: content.Text}})
				continue
			}
			if content.Type != "input_text" && content.Type != "output_text" {
				continue
			}
			text := content.Text
			if item.Payload.Role == "user" {
				text = visibleUserText(text)
			}
			if text != "" {
				parts = append(parts, text)
			}
		}
		if len(parts) > 0 {
			kind := "assistant"
			if item.Payload.Role == "user" {
				kind = "user"
			}
			out = append(out, parsedEvent{Event: Event{Type: kind, Text: strings.Join(parts, "\n")}})
		}
		if len(out) == 0 {
			return nil
		}
		return out
	default:
		return nil
	}
}

func parseClaudeTrace(line []byte) []parsedEvent {
	var item struct {
		Type    string `json:"type"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &item) != nil || (item.Type != "user" && item.Type != "assistant") || item.Message.Role != item.Type {
		return nil
	}
	var text string
	if json.Unmarshal(item.Message.Content, &text) == nil {
		if text == "" {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: item.Type, Text: text}}}
	}
	var blocks []struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		Thinking  string          `json:"thinking"`
		Name      string          `json:"name"`
		ID        string          `json:"id"`
		ToolUseID string          `json:"tool_use_id"`
		Input     json.RawMessage `json:"input"`
		Content   json.RawMessage `json:"content"`
	}
	if json.Unmarshal(item.Message.Content, &blocks) != nil {
		return nil
	}
	out := make([]parsedEvent, 0, len(blocks))
	for _, block := range blocks {
		switch {
		case block.Type == "thinking" && block.Thinking != "":
			out = append(out, parsedEvent{Event: Event{Type: "thinking", Text: block.Thinking}})
		case block.Type == "text" && block.Text != "":
			out = append(out, parsedEvent{Event: Event{Type: item.Type, Text: block.Text}})
		case item.Type == "assistant" && block.Type == "tool_use" && toolName.MatchString(block.Name):
			out = append(out, parsedEvent{
				Event: Event{Type: "tool", Name: block.Name, Input: compactJSON(block.Input)},
				call:  block.ID,
			})
		case item.Type == "user" && block.Type == "tool_result":
			output := flattenToolContent(block.Content)
			if output == "" {
				continue
			}
			out = append(out, parsedEvent{
				Event:      Event{Type: "tool", Output: output},
				call:       block.ToolUseID,
				outputOnly: true,
			})
		}
	}
	return out
}

func parseGrokTrace(line []byte) []parsedEvent {
	var update struct {
		Method string `json:"method"`
		Params struct {
			Update struct {
				SessionUpdate string          `json:"sessionUpdate"`
				MessageID     string          `json:"messageId"`
				ToolCallID    string          `json:"toolCallId"`
				Title         string          `json:"title"`
				Kind          string          `json:"kind"`
				Status        string          `json:"status"`
				RawInput      json.RawMessage `json:"rawInput"`
				RawOutput     json.RawMessage `json:"rawOutput"`
				Content       json.RawMessage `json:"content"`
				Meta          json.RawMessage `json:"_meta"`
			} `json:"update"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &update) != nil || update.Method != "session/update" {
		return nil
	}
	u := update.Params.Update
	switch u.SessionUpdate {
	case "user_message_chunk":
		text := grokChunkText(u.Content)
		if text == "" {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: "user", Text: text}, mergeKey: grokMergeKey("user", u.MessageID)}}
	case "agent_message_chunk":
		text := grokChunkText(u.Content)
		if text == "" {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: "assistant", Text: text}, mergeKey: grokMergeKey("assistant", u.MessageID)}}
	case "agent_thought_chunk":
		text := grokChunkText(u.Content)
		if text == "" {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: "thinking", Text: text}, mergeKey: grokMergeKey("thinking", u.MessageID)}}
	case "tool_call":
		name := grokToolName(u.Title, grokMetaName(u.Meta), u.Kind)
		if name == "" {
			return nil
		}
		return []parsedEvent{{
			Event: Event{Type: "tool", Name: name, Input: compactJSON(u.RawInput)},
			call:  u.ToolCallID,
		}}
	case "tool_call_update", "tool_result", "tool_call_result":
		output := flattenToolContent(u.Content)
		if output == "" {
			output = flattenToolContent(u.RawOutput)
		}
		if output == "" && u.Status == "failed" {
			output = "失败"
		} else if output == "" && u.Status == "completed" {
			output = "完成"
		}
		if output == "" {
			return nil
		}
		return []parsedEvent{{
			Event:      Event{Type: "tool", Name: grokToolName(u.Title, grokMetaName(u.Meta), u.Kind), Output: output},
			call:       u.ToolCallID,
			outputOnly: true,
		}}
	default:
		return nil
	}
}

func grokMergeKey(kind, messageID string) string {
	if messageID == "" {
		return kind
	}
	return kind + ":" + messageID
}

func grokChunkText(raw json.RawMessage) string {
	var content struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &content) == nil && content.Text != "" {
		return content.Text
	}
	return flattenToolContent(raw)
}

func grokMetaName(raw json.RawMessage) string {
	var meta struct {
		Tool struct {
			Name string `json:"name"`
		} `json:"x.ai/tool"`
	}
	if json.Unmarshal(raw, &meta) != nil {
		return ""
	}
	return meta.Tool.Name
}
