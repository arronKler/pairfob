package journal

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

func (r *Reader) kimiTranscriptPath(ref Ref) (string, error) {
	var found []string
	for _, base := range []string{r.NativeRoots["kimi"], r.NativeRoots["kimi-code"]} {
		if base == "" {
			continue
		}
		for _, pattern := range []string{
			filepath.Join(base, "sessions", "*", ref.Value, "wire.jsonl"),
			filepath.Join(base, "sessions", "*", ref.Value, "agents", "main", "wire.jsonl"),
			filepath.Join(base, "sessions", "*", "session_"+ref.Value, "agents", "main", "wire.jsonl"),
		} {
			paths, _ := filepath.Glob(pattern)
			for _, path := range paths {
				if _, err := verifiedRegular(base, path); err != nil {
					return "", err
				}
				found = append(found, path)
			}
		}
	}
	if len(found) != 1 {
		return "", ErrUnavailable
	}
	return found[0], nil
}

func (r *Reader) kimiTranscriptBase(path string) string {
	for _, base := range []string{r.NativeRoots["kimi"], r.NativeRoots["kimi-code"]} {
		if base != "" {
			if _, err := verifiedRegular(base, path); err == nil {
				return base
			}
		}
	}
	return ""
}

func kimiStatePath(path string) string {
	dir := filepath.Dir(path)
	if filepath.Base(dir) == "main" && filepath.Base(filepath.Dir(dir)) == "agents" {
		dir = filepath.Dir(filepath.Dir(dir))
	}
	return filepath.Join(dir, "state.json")
}

func (r *Reader) parseKimiSession(data []byte, ref Ref, path, base string) ([]storeRecord, Title, error) {
	current := filepath.Base(filepath.Dir(path)) == "main"
	var state struct {
		Version     int    `json:"version"`
		ID          string `json:"id"`
		Title       string `json:"title"`
		CustomTitle string `json:"custom_title"`
	}
	stateOK := readTitleJSON(base, kimiStatePath(path), &state)
	if current && (!stateOK || state.Version != 2 || (state.ID != ref.Value && state.ID != "session_"+ref.Value)) {
		return nil, Title{}, ErrUnavailable
	}
	var records []storeRecord
	header := false
	err := nativeLines(data, func(line []byte) error {
		if !current {
			records = append(records, recordsFromEvents(parseKimiTrace(line), 0)...)
			return nil
		}
		var row struct {
			Type     string `json:"type"`
			Protocol string `json:"protocol_version"`
		}
		if json.Unmarshal(line, &row) != nil {
			return ErrUnavailable
		}
		if !header {
			if row.Type != "metadata" || row.Protocol != "1.5" {
				return ErrUnavailable
			}
			header = true
			return nil
		}
		records = append(records, kimiCodeRecords(line)...)
		return nil
	})
	title := Title{Name: titleText(state.CustomTitle, 256), Prompt: firstStorePrompt(records)}
	if current && title.Name == "" {
		title.Name = titleText(state.Title, 256)
	}
	return records, title, err
}

// Kimi Code 0.38 wire protocol 1.5 records both model context and display
// events. Use the main agent's turn.prompt and loop events only, avoiding the
// duplicate context message and all injected profile/system prompt material.
func kimiCodeRecords(line []byte) []storeRecord {
	var row struct {
		Type    string          `json:"type"`
		AgentID string          `json:"agentId"`
		Time    json.RawMessage `json:"time"`
		Origin  struct {
			Kind string `json:"kind"`
		} `json:"origin"`
		Input json.RawMessage `json:"input"`
		Event struct {
			Type       string                             `json:"type"`
			ToolCallID string                             `json:"toolCallId"`
			Name       string                             `json:"name"`
			Args       json.RawMessage                    `json:"args"`
			Part       struct{ Type, Text, Think string } `json:"part"`
			Result     struct {
				Output  json.RawMessage `json:"output"`
				IsError bool            `json:"isError"`
				Error   json.RawMessage `json:"error"`
			} `json:"result"`
		} `json:"event"`
	}
	if json.Unmarshal(line, &row) != nil || row.AgentID != "main" {
		return nil
	}
	record := storeRecord{At: recordTime(row.Time)}
	switch row.Type {
	case "turn.prompt":
		if row.Origin.Kind != "user" {
			return nil
		}
		record.Kind, record.Text = storeUser, visibleCodexUserText(kimiText(row.Input))
	case "context.append_loop_event":
		e := row.Event
		switch e.Type {
		case "content.part":
			switch e.Part.Type {
			case "text":
				record.Kind, record.Text = storeAssistant, e.Part.Text
			case "think":
				record.Kind, record.Text = storeThinking, e.Part.Think
			default:
				return nil
			}
		case "tool.call":
			record.Kind, record.Call, record.Name, record.Input = storeTool, e.ToolCallID, e.Name, string(e.Args)
		case "tool.result":
			record.Kind, record.Call, record.Output, record.State = storeResult, e.ToolCallID, kimiText(e.Result.Output), "done"
			if e.Result.IsError || (len(e.Result.Error) > 0 && string(e.Result.Error) != "null" && string(e.Result.Error) != `""`) {
				record.State = "error"
			}
		case "step.interrupted":
			record.Kind = storeInterrupt
		default:
			return nil
		}
	default:
		return nil
	}
	if (record.Kind == storeAssistant || record.Kind == storeThinking || record.Kind == storeUser) && strings.TrimSpace(record.Text) == "" {
		return nil
	}
	return []storeRecord{record}
}
