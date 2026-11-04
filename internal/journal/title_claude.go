package journal

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// Claude appends ai-title and custom-title metadata to its bound transcript.
// Read the head for the first real request and the tail for later renames;
// tool output must not make periodic snapshot reads scan an unbounded log.
func (r *Reader) claudeTitle(ref Ref) (Title, bool) {
	path, err := r.transcriptPath(ref, false)
	if err != nil {
		return Title{}, false
	}
	file, err := openActivityFile(r.transcriptBase(ref.Agent), path)
	if err != nil {
		return Title{}, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Title{}, false
	}
	var state claudeTitleState
	headEnd := min(info.Size(), int64(titleReadBytes))
	if err := state.read(file, 0, headEnd, ref.Value, true); err != nil {
		return Title{}, false
	}
	if info.Size() > headEnd {
		start := info.Size() - titleReadBytes
		// Include the preceding byte so an exact line boundary is preserved.
		if err := state.read(file, start-1, info.Size(), ref.Value, false); err != nil {
			return Title{}, false
		}
	}
	name := state.custom
	if name == "" {
		name = state.generated
	}
	return Title{Name: name, Prompt: state.prompt}, true
}

type claudeTitleState struct {
	custom, generated, prompt string
}

func (s *claudeTitleState) read(file io.ReaderAt, start, end int64, id string, prompts bool) error {
	data := make([]byte, end-start)
	if _, err := file.ReadAt(data, start); err != nil {
		return err
	}
	if start > 0 {
		first := bytes.IndexByte(data, '\n')
		if first < 0 {
			return nil
		}
		data = data[first+1:]
	}
	// Ignore unfinished records, both at the head limit and during appends.
	for {
		line, rest, complete := bytes.Cut(data, []byte{'\n'})
		if !complete {
			break
		}
		data = rest
		if len(line) > maxTranscriptLine {
			continue
		}
		var record struct {
			claudeRecordFlags
			Type        string  `json:"type"`
			SessionID   string  `json:"sessionId"`
			AITitle     *string `json:"aiTitle"`
			CustomTitle *string `json:"customTitle"`
		}
		if json.Unmarshal(line, &record) != nil || record.hidden() ||
			(record.SessionID != "" && record.SessionID != id) {
			continue
		}
		switch record.Type {
		case "ai-title":
			if record.SessionID == id && record.AITitle != nil {
				s.generated = titleText(*record.AITitle, 256)
			}
		case "custom-title":
			if record.SessionID == id && record.CustomTitle != nil {
				s.custom = titleText(*record.CustomTitle, 256)
			}
		case "user":
			if !prompts || s.prompt != "" {
				continue
			}
			for _, event := range parseClaudeTrace(line) {
				prompt := ""
				switch {
				case event.Type == "user":
					prompt = promptTitle(event.Text)
				case event.Type == EventCommand && strings.HasPrefix(event.Text, "/"):
					prompt = commandTitle(event.Text)
				}
				if prompt != "" {
					s.prompt = prompt
					break
				}
			}
		}
	}
	return nil
}

// commandTitle reads the request a typed slash command carries. The command
// name is the carrier, not the task; "/pstack:poteto-mode 修标题" is "修标题",
// and "/goal /poteto-mode 修标题" nests command names that a path would not.
func commandTitle(text string) string {
	fields := strings.Fields(text)
	for len(fields) > 1 && strings.HasPrefix(fields[0], "/") && !strings.Contains(fields[0][1:], "/") {
		fields = fields[1:]
	}
	return promptTitle(strings.Join(fields, " "))
}
