package journal

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// Event is one step on the agent execution timeline.
type Event struct {
	Type             string `json:"type"`
	Text             string `json:"text,omitempty"`
	Name             string `json:"name,omitempty"`
	Input            string `json:"input,omitempty"`
	Output           string `json:"output,omitempty"`
	DetailRef        string `json:"-"`
	State            string `json:"-"`
	Label            string `json:"-"`
	At               int64  `json:"-"`
	DetailTruncated  bool   `json:"-"`
	SummaryTruncated bool   `json:"-"`
}

type TracePage struct {
	Items            []Event `json:"items"`
	NextCursor       *string `json:"next_cursor"`
	Truncated        bool    `json:"truncated"`
	SummaryTruncated bool    `json:"-"`
}

type TraceSummaryItem struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	Name      string `json:"name,omitempty"`
	State     string `json:"state,omitempty"`
	DetailRef string `json:"detail_ref,omitempty"`
	Label     string `json:"label,omitempty"`
	At        int64  `json:"at,omitempty"`
}

type TraceSummaryPage struct {
	Items      []TraceSummaryItem `json:"items"`
	NextCursor *string            `json:"next_cursor"`
	Truncated  bool               `json:"truncated"`
}

type TraceDetail struct {
	DetailRef string `json:"detail_ref"`
	Text      string `json:"text,omitempty"`
	Input     string `json:"input,omitempty"`
	Output    string `json:"output,omitempty"`
	Truncated bool   `json:"truncated"`
}

type parsedEvent struct {
	Event
	call          string
	mergeKey      string
	lineStart     int
	sourceOrdinal int
	outputOnly    bool
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
	ev.Output, truncated = clipHeadTail(ev.Output, maxMessageBytes, truncated)
	for eventSize(ev) > limit {
		field := largestEventField(&ev)
		if field == nil {
			break
		}
		before := eventSize(ev)
		if field == &ev.Output {
			*field = shrinkHeadTail(*field)
		} else {
			*field = shrinkEventField(*field)
		}
		// Keep the loop strictly decreasing even if JSON escaping rules change.
		if eventSize(ev) >= before {
			*field = ""
		}
		truncated = true
	}
	return ev, truncated
}

func shrinkEventField(value string) string {
	// clip's limit applies to the retained prefix, while its UTF-8 ellipsis costs
	// three more bytes. Budget the complete replacement so five- and six-byte
	// fields cannot reproduce their original encoded size forever.
	target := len(value) / 2
	if target < len("…") {
		return ""
	}
	clipped, _ := clip(value, target-len("…"), false)
	return clipped
}

// toolOutputGap marks the bytes removed from the middle of a tool output.
const toolOutputGap = "\n…\n"

// clipHeadTail is clip for tool output: command results and test summaries
// sit at the end, so it keeps a head and a tail around toolOutputGap. The
// result is never longer than clip's prefix plus its ellipsis.
func clipHeadTail(text string, limit int, already bool) (string, bool) {
	if len(text) <= limit {
		return text, already
	}
	keep := limit + len("…") - len(toolOutputGap)
	if keep < 2 {
		return clip(text, limit, already)
	}
	return headTail(text, keep), true
}

// shrinkHeadTail halves a tool output the way shrinkEventField halves a
// prefix-clipped field, budgeting the gap marker into the half.
func shrinkHeadTail(value string) string {
	keep := len(value)/2 - len(toolOutputGap)
	if keep < 2 {
		return ""
	}
	return headTail(value, keep)
}

// headTail keeps at most keep bytes of text, split between its start and its
// end on UTF-8 boundaries, joined by toolOutputGap.
func headTail(text string, keep int) string {
	head := keep / 2
	for head > 0 && !utf8.RuneStart(text[head]) {
		head--
	}
	tail := len(text) - (keep - head)
	for tail < len(text) && !utf8.RuneStart(text[tail]) {
		tail++
	}
	return text[:head] + toolOutputGap + text[tail:]
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

// The parsers name their result so one deferred stampEvents dates every
// return path with the record's own timestamp.
func parseCodexTrace(line []byte) (events []parsedEvent) {
	var item struct {
		Type      string          `json:"type"`
		Timestamp json.RawMessage `json:"timestamp"`
		Payload   struct {
			Type      string          `json:"type"`
			Role      string          `json:"role"`
			Reason    string          `json:"reason"`
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
	if json.Unmarshal(line, &item) != nil {
		return nil
	}
	defer func() { stampEvents(events, item.Timestamp) }()
	switch {
	case item.Type == "compacted":
		return []parsedEvent{{Event: Event{Type: EventCompaction}}}
	case item.Type == "event_msg" && item.Payload.Type == "turn_aborted":
		// Only a user cancel is an interrupt; "replaced" and "review_ended"
		// end a turn the user moved past on purpose.
		if item.Payload.Reason != "interrupted" {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: EventInterrupt}}}
	case item.Type != "response_item":
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
			Event:      Event{Type: "tool", Output: output, State: codexOutputState(output)},
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
				text = visibleCodexUserText(text)
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

func parseClaudeTrace(line []byte) (events []parsedEvent) {
	var item struct {
		claudeRecordFlags
		Type      string          `json:"type"`
		Subtype   string          `json:"subtype"`
		Timestamp json.RawMessage `json:"timestamp"`
		Message   struct {
			Role    string          `json:"role"`
			Model   string          `json:"model"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &item) != nil {
		return nil
	}
	defer func() { stampEvents(events, item.Timestamp) }()
	if item.Type == "system" && item.Subtype == "compact_boundary" && !item.IsSidechain {
		return []parsedEvent{{Event: Event{Type: EventCompaction}}}
	}
	if (item.Type != "user" && item.Type != "assistant") || item.Message.Role != item.Type {
		return nil
	}
	if item.hidden() || item.syntheticPlaceholder(item.Message.Model) {
		return nil
	}
	var text string
	if json.Unmarshal(item.Message.Content, &text) == nil {
		if item.Type == "user" {
			if events, ok := claudeShellEvents(text); ok {
				return events
			}
			if event, ok := claudeUserEvent(text); ok {
				return []parsedEvent{{Event: event}}
			}
			return nil
		}
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
		IsError   bool            `json:"is_error"`
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
			if item.Type != "user" {
				out = append(out, parsedEvent{Event: Event{Type: item.Type, Text: block.Text}})
			} else if events, ok := claudeShellEvents(block.Text); ok {
				out = append(out, events...)
			} else if event, ok := claudeUserEvent(block.Text); ok {
				out = append(out, parsedEvent{Event: event})
			}
		case item.Type == "assistant" && block.Type == "tool_use" && toolName.MatchString(block.Name):
			out = append(out, parsedEvent{
				Event: Event{Type: "tool", Name: block.Name, Input: compactJSON(block.Input)},
				call:  block.ID,
			})
		case item.Type == "user" && block.Type == "tool_result":
			output := visibleClaudeToolOutput(flattenToolContent(block.Content))
			if output == "" {
				continue
			}
			state := "done"
			if block.IsError {
				state = "error"
			}
			out = append(out, parsedEvent{
				Event:      Event{Type: "tool", Output: output, State: state},
				call:       block.ToolUseID,
				outputOnly: true,
			})
		}
	}
	return out
}

func parseGrokTrace(line []byte) (events []parsedEvent) {
	var update struct {
		// Timestamp is the write time in epoch seconds; the agent's own clock
		// in params._meta.agentTimestampMs is preferred for its precision.
		Timestamp json.RawMessage `json:"timestamp"`
		Method    string          `json:"method"`
		Params    struct {
			Meta struct {
				AgentTimestampMs json.RawMessage `json:"agentTimestampMs"`
			} `json:"_meta"`
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
				StopReason    string          `json:"stop_reason"`
			} `json:"update"`
		} `json:"params"`
	}
	// Grok writes its own lifecycle events (turn_completed and friends) as
	// "_x.ai/session/update"; the ACP stream proper is "session/update".
	if json.Unmarshal(line, &update) != nil || (update.Method != "session/update" && update.Method != "_x.ai/session/update") {
		return nil
	}
	defer func() { stampEvents(events, update.Params.Meta.AgentTimestampMs, update.Timestamp) }()
	u := update.Params.Update
	switch u.SessionUpdate {
	case "turn_completed":
		if u.StopReason != "cancelled" {
			return nil
		}
		return []parsedEvent{{Event: Event{Type: EventInterrupt}}}
	case "user_message_chunk":
		text := visibleGrokUserText(grokChunkText(u.Content), u.Meta)
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
		// The status Grok records is the outcome, whatever text came with it.
		state := ""
		switch u.Status {
		case "failed":
			state = "error"
		case "completed":
			state = "done"
		}
		return []parsedEvent{{
			Event:      Event{Type: "tool", Name: grokToolName(u.Title, grokMetaName(u.Meta), u.Kind), Output: output, State: state},
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
