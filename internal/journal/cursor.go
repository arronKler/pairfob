package journal

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// The Cursor CLI (cursor-agent) keeps one transcript per chat at
// <root>/projects/<project>/agent-transcripts/<id>/<id>.jsonl, where <id> is
// the session id its hook reports. A record is a user or assistant message
// (text and tool calls) or a turn_ended marker. Tool results, failures and
// times are not recorded.

func findCursorTranscript(root, id string) (string, error) {
	base := filepath.Join(root, "projects")
	matches, err := filepath.Glob(filepath.Join(base, "*", "agent-transcripts", id, id+".jsonl"))
	if err != nil {
		return "", err
	}
	if len(matches) != 1 {
		return "", ErrUnavailable
	}
	return verifiedRegular(base, matches[0])
}

type cursorRecord struct {
	Role    string `json:"role"`
	Type    string `json:"type"`
	Message struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// visibleCursorUserText keeps what the user typed. Cursor wraps it in
// <user_query> beside context it adds itself (a timestamp, attached files); a
// message that is only such context is not a prompt.
func visibleCursorUserText(text string) string {
	if body, ok := taggedBody(text, "user_query"); ok {
		return strings.TrimSpace(body)
	}
	rest := strings.TrimSpace(stripTaggedBlocks(text, []string{"timestamp"}))
	if strings.HasPrefix(rest, "<") {
		return ""
	}
	return rest
}

func parseCursor(line []byte) (Message, bool) {
	var record cursorRecord
	if json.Unmarshal(line, &record) != nil || (record.Role != "user" && record.Role != "assistant") {
		return Message{}, false
	}
	parts := make([]string, 0, len(record.Message.Content))
	for _, block := range record.Message.Content {
		switch {
		case block.Type == "text" && block.Text != "":
			text := block.Text
			if record.Role == "user" {
				text = visibleCursorUserText(text)
			}
			if text != "" {
				parts = append(parts, text)
			}
		case record.Role == "assistant" && block.Type == "tool_use" && toolName.MatchString(block.Name):
			parts = append(parts, "工具 · "+block.Name)
		}
	}
	if len(parts) == 0 {
		return Message{}, false
	}
	return Message{Role: record.Role, Text: strings.Join(parts, "\n")}, true
}

// parseCursorTrace marks its tools unresulted and every record as settling:
// Cursor writes an assistant message before its tools run, so the next record
// (or turn_ended) is the only evidence that they finished.
func parseCursorTrace(line []byte) []parsedEvent {
	var record cursorRecord
	if json.Unmarshal(line, &record) != nil {
		return nil
	}
	if record.Type == "turn_ended" {
		return []parsedEvent{{settles: true}}
	}
	if record.Role != "user" && record.Role != "assistant" {
		return nil
	}
	out := make([]parsedEvent, 0, len(record.Message.Content))
	for _, block := range record.Message.Content {
		switch {
		case block.Type == "text" && block.Text != "":
			text := block.Text
			if record.Role == "user" {
				text = visibleCursorUserText(text)
			}
			if text != "" {
				out = append(out, parsedEvent{Event: Event{Type: record.Role, Text: text}, settles: true})
			}
		case record.Role == "assistant" && block.Type == "tool_use" && toolName.MatchString(block.Name):
			out = append(out, parsedEvent{
				Event:      Event{Type: "tool", Name: block.Name, Input: compactJSON(block.Input)},
				unresulted: true, settles: true,
			})
		}
	}
	if len(out) == 0 {
		// A record with nothing to show still proves earlier tools finished.
		return []parsedEvent{{settles: true}}
	}
	return out
}
