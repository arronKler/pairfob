package journal

import (
	"encoding/json"
	"regexp"
	"strings"
)

var commandCodeIDEContext = regexp.MustCompile(`(?s)<ide-context>.*?</ide-context>\s*`)

// Command Code 1.88 persists V3 trees. Its selected leaf is held in memory;
// only the pane-local mod can tell us which branch is currently on screen.
type commandCodeEntry struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Parent    *string         `json:"parentId"`
	Timestamp json.RawMessage `json:"timestamp"`
	Name      string          `json:"name"`
	Message   json.RawMessage `json:"message"`
}

func commandCodeMetaPath(path string) string {
	return strings.TrimSuffix(path, ".jsonl") + ".meta.json"
}

func (r *Reader) parseCommandCodeSession(data []byte, ref Ref, path string) ([]storeRecord, Title, error) {
	var title Title
	var meta struct{ Title string }
	if readTitleJSON(r.NativeRoots["cmd"], commandCodeMetaPath(path), &meta) {
		title.Name = titleText(meta.Title, 256)
	}
	entries := map[string]commandCodeEntry{}
	header := false
	err := nativeLines(data, func(line []byte) error {
		if !header {
			var row struct {
				Type    string
				Version int
				ID      string
			}
			if json.Unmarshal(line, &row) != nil || row.Type != "session" || row.Version != 3 || row.ID != ref.Value {
				return ErrUnavailable
			}
			header = true
			return nil
		}
		var row commandCodeEntry
		if json.Unmarshal(line, &row) != nil || !sessionID.MatchString(row.ID) {
			return ErrUnavailable
		}
		if _, exists := entries[row.ID]; exists {
			return ErrUnavailable
		}
		// Validate the whole tree, including branches not selected now.
		if row.Parent != nil {
			if _, exists := entries[*row.Parent]; !exists {
				return ErrUnavailable
			}
		}
		switch row.Type {
		case "message", "model_change", "effort_change", "compaction", "branch_summary", "custom", "custom_message", "label":
		case "session_info":
			title.Name = titleText(row.Name, 256)
		default:
			return ErrUnavailable
		}
		entries[row.ID] = row
		return nil
	})
	if err != nil || !header || ref.Leaf == nil {
		return nil, Title{}, ErrUnavailable
	}
	var branch []commandCodeEntry
	for leaf := *ref.Leaf; leaf != ""; {
		row, exists := entries[leaf]
		if !exists || len(branch) >= len(entries) {
			return nil, Title{}, ErrUnavailable
		}
		branch = append(branch, row)
		leaf = ""
		if row.Parent != nil {
			leaf = *row.Parent
		}
	}
	var records []storeRecord
	for i := len(branch) - 1; i >= 0; i-- {
		row := branch[i]
		at := recordTime(row.Timestamp)
		switch row.Type {
		case "compaction", "branch_summary":
			records = append(records, storeRecord{Kind: storeCompaction, At: at})
		case "message":
			parsed, err := commandCodeMessage(row.Message, at)
			if err != nil {
				return nil, Title{}, err
			}
			records = append(records, parsed...)
		}
	}
	title.Prompt = firstStorePrompt(records)
	return records, title, nil
}

func commandCodeMessage(raw json.RawMessage, at int64) ([]storeRecord, error) {
	var message struct {
		Role    string
		Content json.RawMessage
		Meta    struct {
			IsMeta, IsAutomated, IsSummary bool
			Source                         string
		}
	}
	if json.Unmarshal(raw, &message) != nil {
		return nil, ErrUnavailable
	}
	if message.Role != "user" && message.Role != "assistant" {
		return nil, nil
	}
	if message.Meta.IsMeta || message.Meta.IsAutomated || message.Meta.IsSummary {
		return nil, nil
	}
	var blocks []json.RawMessage
	if json.Unmarshal(message.Content, &blocks) != nil {
		return nil, ErrUnavailable
	}
	var visible []json.RawMessage
	for _, raw := range blocks {
		var block struct{ Type, Text string }
		if json.Unmarshal(raw, &block) != nil {
			return nil, ErrUnavailable
		}
		if message.Role == "user" {
			if block.Type == "text" {
				// Tool batches and queued/mod input can contain extra context.
				if message.Meta.Source != "" && message.Meta.Source != "user" {
					continue
				}
				block.Text = commandCodeIDEContext.ReplaceAllString(block.Text, "")
				raw, _ = json.Marshal(map[string]string{"type": "text", "text": block.Text})
			} else if block.Type != "tool_result" {
				continue
			}
		}
		visible = append(visible, raw)
	}
	content, _ := json.Marshal(visible)
	return anthropicRecords(message.Role, content, at), nil
}
