package journal

import (
	"bytes"
	"encoding/json"
)

// claudeImagePrefilterMin is the record size at which proving an image-only
// shape is cheaper than decoding the record to discover the same thing.
const (
	claudeImagePrefilterMin = 16 << 10
	// Every writer seen so far puts the result marker in the record's first
	// bytes. A record that buries it deeper is parsed normally.
	claudeImagePrefilterHint = 512
)

// Claude Code records a screenshot tool result as an image block carrying the
// whole picture as base64. The chat has no text form for it, so decoding the
// record only costs time and allocates the payload; the parser emits nothing.
//
// This prefilter recognizes that shape structurally, and only when it is sure:
// any other key, value or block makes it answer false and the record is parsed
// normally. It never decides that a record has text when it might not.

// claudeImageOnlyUserRecord reports a user record whose message content is
// only image tool results. The record is skipped before JSON decoding.
func claudeImageOnlyUserRecord(line []byte) bool {
	pos := skipJSONSpace(line, 0)
	if pos >= len(line) || line[pos] != '{' {
		return false
	}
	pos++
	var (
		isUser        bool
		sawMessage    bool
		messageImages bool
	)
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return false
		}
		if line[pos] == '}' {
			return isUser && sawMessage && messageImages
		}
		key, next, ok := scanJSONString(line, pos)
		if !ok {
			return false
		}
		pos = skipJSONSpace(line, next)
		if pos >= len(line) || line[pos] != ':' {
			return false
		}
		pos = skipJSONSpace(line, pos+1)
		switch {
		case bytes.Equal(key, []byte(`"type"`)):
			value, after, ok := scanJSONString(line, pos)
			if !ok {
				return false
			}
			isUser = bytes.Equal(value, []byte(`"user"`))
			pos = after
		case bytes.Equal(key, []byte(`"message"`)):
			images, after, ok := scanClaudeImageMessage(line, pos)
			if !ok {
				return false
			}
			sawMessage = true
			messageImages = images
			pos = after
		default:
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return false
			}
			pos = after
		}
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == '}' {
			return isUser && sawMessage && messageImages
		}
		return false
	}
}

// scanClaudeImageMessage recognizes {"role":"user","content":[{"type":
// "tool_result","content":[{"type":"image",...}]}]} with no other content
// block. Anything else is not this fast path.
func scanClaudeImageMessage(line []byte, pos int) (bool, int, bool) {
	if pos >= len(line) || line[pos] != '{' {
		return false, 0, false
	}
	pos++
	var (
		roleUser bool
		sawBody  bool
		images   bool
	)
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return false, 0, false
		}
		if line[pos] == '}' {
			return roleUser && sawBody && images, pos + 1, true
		}
		key, next, ok := scanJSONString(line, pos)
		if !ok {
			return false, 0, false
		}
		pos = skipJSONSpace(line, next)
		if pos >= len(line) || line[pos] != ':' {
			return false, 0, false
		}
		pos = skipJSONSpace(line, pos+1)
		switch {
		case bytes.Equal(key, []byte(`"role"`)):
			value, after, ok := scanJSONString(line, pos)
			if !ok {
				return false, 0, false
			}
			roleUser = bytes.Equal(value, []byte(`"user"`))
			pos = after
		case bytes.Equal(key, []byte(`"content"`)):
			blocksImage, after, ok := scanClaudeImageBlocks(line, pos)
			if !ok {
				return false, 0, false
			}
			sawBody = true
			images = blocksImage
			pos = after
		default:
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return false, 0, false
			}
			pos = after
		}
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == '}' {
			return roleUser && sawBody && images, pos + 1, true
		}
		return false, 0, false
	}
}

// scanClaudeImageBlocks requires an array of tool_result blocks whose content
// is, in turn, a non-empty array of image blocks.
func scanClaudeImageBlocks(line []byte, pos int) (bool, int, bool) {
	if pos >= len(line) || line[pos] != '[' {
		return false, 0, false
	}
	pos++
	blocks := 0
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return false, 0, false
		}
		if line[pos] == ']' {
			return blocks > 0, pos + 1, true
		}
		if line[pos] != '{' {
			return false, 0, false
		}
		after, ok := scanClaudeToolResult(line, pos)
		if !ok {
			return false, 0, false
		}
		blocks++
		pos = after
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == ']' {
			return blocks > 0, pos + 1, true
		}
		return false, 0, false
	}
}

// scanClaudeToolResult reads one content block. It returns whether the block
// is an image-only tool result, and advances past it.
func scanClaudeToolResult(line []byte, pos int) (int, bool) {
	pos++
	var (
		sawType      bool
		isToolResult bool
		sawContent   bool
		contentOK    bool
	)
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return 0, false
		}
		if line[pos] == '}' {
			if !sawType || !isToolResult || !sawContent || !contentOK {
				return 0, false
			}
			return pos + 1, true
		}
		key, next, ok := scanJSONString(line, pos)
		if !ok {
			return 0, false
		}
		pos = skipJSONSpace(line, next)
		if pos >= len(line) || line[pos] != ':' {
			return 0, false
		}
		pos = skipJSONSpace(line, pos+1)
		switch {
		case bytes.Equal(key, []byte(`"type"`)):
			value, after, ok := scanJSONString(line, pos)
			if !ok {
				return 0, false
			}
			sawType = true
			isToolResult = bytes.Equal(value, []byte(`"tool_result"`))
			pos = after
		case bytes.Equal(key, []byte(`"content"`)):
			ok, after := scanClaudeImageContent(line, pos)
			if !ok {
				return 0, false
			}
			sawContent = true
			contentOK = true
			pos = after
		default:
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return 0, false
			}
			pos = after
		}
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == '}' {
			if !sawType || !isToolResult || !sawContent || !contentOK {
				return 0, false
			}
			return pos + 1, true
		}
		return 0, false
	}
}

// scanClaudeImageContent requires a non-empty array of image blocks.
func scanClaudeImageContent(line []byte, pos int) (bool, int) {
	if pos >= len(line) || line[pos] != '[' {
		return false, 0
	}
	pos++
	images := 0
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return false, 0
		}
		if line[pos] == ']' {
			return images > 0, pos + 1
		}
		if line[pos] != '{' {
			return false, 0
		}
		after, ok := scanClaudeImageBlock(line, pos)
		if !ok {
			return false, 0
		}
		images++
		pos = after
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == ']' {
			return images > 0, pos + 1
		}
		return false, 0
	}
}

// scanClaudeImageBlock handles one {"type":"image",...} object. A block with a
// text or nested content field is not image-only and rejects the fast path.
func scanClaudeImageBlock(line []byte, pos int) (int, bool) {
	pos++
	var sawImage bool
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return 0, false
		}
		if line[pos] == '}' {
			if !sawImage {
				return 0, false
			}
			return pos + 1, true
		}
		key, next, ok := scanJSONString(line, pos)
		if !ok {
			return 0, false
		}
		pos = skipJSONSpace(line, next)
		if pos >= len(line) || line[pos] != ':' {
			return 0, false
		}
		pos = skipJSONSpace(line, pos+1)
		switch {
		case bytes.Equal(key, []byte(`"type"`)):
			value, after, ok := scanJSONString(line, pos)
			if !ok || !bytes.Equal(value, []byte(`"image"`)) {
				return 0, false
			}
			sawImage = true
			pos = after
		case bytes.Equal(key, []byte(`"text"`)), bytes.Equal(key, []byte(`"content"`)):
			return 0, false
		default:
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return 0, false
			}
			pos = after
		}
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == '}' {
			if !sawImage {
				return 0, false
			}
			return pos + 1, true
		}
		return 0, false
	}
}

// topLevelJSONType reads the record's own "type" field without decoding the
// record. A record whose type can never produce a chat event is skipped
// without validating or copying the rest of it. false means the shape was not
// understood and the caller must parse normally.
func topLevelJSONType(line []byte) (string, bool) {
	pos := skipJSONSpace(line, 0)
	if pos >= len(line) || line[pos] != '{' {
		return "", false
	}
	pos++
	kind, seen := "", false
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return "", false
		}
		if line[pos] == '}' {
			return kind, seen
		}
		key, next, ok := scanJSONString(line, pos)
		if !ok {
			return "", false
		}
		pos = skipJSONSpace(line, next)
		if pos >= len(line) || line[pos] != ':' {
			return "", false
		}
		pos = skipJSONSpace(line, pos+1)
		if bytes.Equal(key, []byte(`"type"`)) {
			if seen {
				// Duplicate keys decode last-wins; do not guess.
				return "", false
			}
			value, after, ok := scanJSONString(line, pos)
			if !ok {
				return "", false
			}
			kind, ok = plainJSONString(value)
			if !ok {
				return "", false
			}
			seen = true
			pos = after
		} else {
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return "", false
			}
			pos = after
		}
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == '}' {
			return kind, seen
		}
		return "", false
	}
}

// scanClaudeTraceRecord fills the fields the trace reads from the top-level
// object and leaves the rest unread. Claude Code writes every tool result
// twice, in message.content and in toolUseResult; decoding the record would
// scan both. false means the shape was not understood and the caller must
// decode the line in full.
func scanClaudeTraceRecord(line []byte) (claudeTraceRecord, bool) {
	var record claudeTraceRecord
	pos := skipJSONSpace(line, 0)
	if pos >= len(line) || line[pos] != '{' {
		return record, false
	}
	pos++
	for {
		pos = skipJSONSpace(line, pos)
		if pos >= len(line) {
			return record, false
		}
		if line[pos] == '}' {
			return record, true
		}
		key, next, ok := scanJSONString(line, pos)
		if !ok {
			return record, false
		}
		pos = skipJSONSpace(line, next)
		if pos >= len(line) || line[pos] != ':' {
			return record, false
		}
		pos = skipJSONSpace(line, pos+1)
		switch {
		case bytes.Equal(key, []byte(`"type"`)):
			value, after, ok := scanJSONString(line, pos)
			if !ok {
				return record, false
			}
			if record.Type, ok = plainJSONString(value); !ok {
				return record, false
			}
			pos = after
		case bytes.Equal(key, []byte(`"subtype"`)):
			value, after, ok := scanJSONString(line, pos)
			if !ok {
				return record, false
			}
			if record.Subtype, ok = plainJSONString(value); !ok {
				return record, false
			}
			pos = after
		case bytes.Equal(key, []byte(`"timestamp"`)):
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return record, false
			}
			record.Timestamp = line[pos:after]
			pos = after
		case bytes.Equal(key, []byte(`"message"`)):
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return record, false
			}
			if json.Unmarshal(line[pos:after], &record.Message) != nil {
				return record, false
			}
			pos = after
		case bytes.Equal(key, []byte(`"isMeta"`)), bytes.Equal(key, []byte(`"isSidechain"`)),
			bytes.Equal(key, []byte(`"isCompactSummary"`)), bytes.Equal(key, []byte(`"isVisibleInTranscriptOnly"`)),
			bytes.Equal(key, []byte(`"isApiErrorMessage"`)):
			value, after, ok := scanClaudeFlag(line, pos)
			if !ok {
				return record, false
			}
			switch {
			case bytes.Equal(key, []byte(`"isMeta"`)):
				record.IsMeta = value
			case bytes.Equal(key, []byte(`"isSidechain"`)):
				record.IsSidechain = value
			case bytes.Equal(key, []byte(`"isCompactSummary"`)):
				record.IsCompactSummary = value
			case bytes.Equal(key, []byte(`"isVisibleInTranscriptOnly"`)):
				record.IsVisibleInTranscriptOnly = value
			default:
				record.IsAPIErrorMessage = value
			}
			pos = after
		default:
			after, ok := skipJSONValue(line, pos)
			if !ok {
				return record, false
			}
			pos = after
		}
		pos = skipJSONSpace(line, pos)
		if pos < len(line) && line[pos] == ',' {
			pos++
			continue
		}
		if pos < len(line) && line[pos] == '}' {
			return record, true
		}
		return record, false
	}
}

func scanClaudeFlag(line []byte, pos int) (bool, int, bool) {
	after, ok := skipJSONValue(line, pos)
	if !ok {
		return false, 0, false
	}
	switch string(bytes.TrimSpace(line[pos:after])) {
	case "true":
		return true, after, true
	case "false":
		return false, after, true
	}
	return false, 0, false
}

// plainJSONString unquotes a string with no escapes; anything else falls back.
func plainJSONString(raw []byte) (string, bool) {
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return "", false
	}
	for _, char := range raw[1 : len(raw)-1] {
		if char == '\\' {
			return "", false
		}
	}
	return string(raw[1 : len(raw)-1]), true
}

func skipJSONSpace(data []byte, pos int) int {
	for pos < len(data) {
		switch data[pos] {
		case ' ', '\t', '\r', '\n':
			pos++
		default:
			return pos
		}
	}
	return pos
}

// scanJSONString returns the raw string token (quotes included) at pos. A
// base64 payload is mostly one long string with no quotes or escapes, so the
// closing quote is found with IndexByte and only its escape run is checked.
func scanJSONString(data []byte, pos int) ([]byte, int, bool) {
	if pos >= len(data) || data[pos] != '"' {
		return nil, 0, false
	}
	from := pos + 1
	for from < len(data) {
		quote := bytes.IndexByte(data[from:], '"')
		if quote < 0 {
			return nil, 0, false
		}
		end := from + quote
		backslashes := 0
		for at := end - 1; at > pos && data[at] == '\\'; at-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			return data[pos : end+1], end + 1, true
		}
		from = end + 1
	}
	return nil, 0, false
}

// skipJSONValue advances past one JSON value.
func skipJSONValue(data []byte, pos int) (int, bool) {
	return skipJSONValueDepth(data, pos, 0)
}

func skipJSONValueDepth(data []byte, pos, depth int) (int, bool) {
	if depth > 512 {
		return 0, false
	}
	pos = skipJSONSpace(data, pos)
	if pos >= len(data) {
		return 0, false
	}
	switch data[pos] {
	case '"':
		_, next, ok := scanJSONString(data, pos)
		return next, ok
	case '{':
		pos++
		for {
			pos = skipJSONSpace(data, pos)
			if pos >= len(data) {
				return 0, false
			}
			if data[pos] == '}' {
				return pos + 1, true
			}
			_, next, ok := scanJSONString(data, pos)
			if !ok {
				return 0, false
			}
			pos = skipJSONSpace(data, next)
			if pos >= len(data) || data[pos] != ':' {
				return 0, false
			}
			pos, ok = skipJSONValueDepth(data, pos+1, depth+1)
			if !ok {
				return 0, false
			}
			pos = skipJSONSpace(data, pos)
			if pos < len(data) && data[pos] == ',' {
				pos++
				continue
			}
			if pos < len(data) && data[pos] == '}' {
				return pos + 1, true
			}
			return 0, false
		}
	case '[':
		pos++
		for {
			pos = skipJSONSpace(data, pos)
			if pos >= len(data) {
				return 0, false
			}
			if data[pos] == ']' {
				return pos + 1, true
			}
			var ok bool
			pos, ok = skipJSONValueDepth(data, pos, depth+1)
			if !ok {
				return 0, false
			}
			pos = skipJSONSpace(data, pos)
			if pos < len(data) && data[pos] == ',' {
				pos++
				continue
			}
			if pos < len(data) && data[pos] == ']' {
				return pos + 1, true
			}
			return 0, false
		}
	default:
		// A number, true, false or null: advance to the end of the token.
		start := pos
		for pos < len(data) {
			switch data[pos] {
			case ',', '}', ']', ' ', '\t', '\r', '\n':
				return pos, pos > start
			}
			pos++
		}
		return pos, pos > start
	}
}
