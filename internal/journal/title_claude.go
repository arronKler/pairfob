package journal

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
)

type claudeTitleCacheEntry struct {
	info  os.FileInfo
	title Title
}

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
	if err != nil || !info.Mode().IsRegular() {
		return Title{}, false
	}
	cacheKey := path + "\x00" + ref.Value
	r.titleMu.Lock()
	cached, exists := r.claudeTitles[cacheKey]
	r.titleMu.Unlock()
	if exists && os.SameFile(info, cached.info) && info.Size() == cached.info.Size() && info.ModTime() == cached.info.ModTime() {
		return cached.title, true
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
	title := Title{Name: name, Prompt: state.prompt}
	// Keep the existing two-second refresh window, but an unchanged, verified
	// file needs no JSON scan. Replacements and appends always get read again.
	after, err := file.Stat()
	if err == nil && info.Size() == after.Size() && info.ModTime() == after.ModTime() {
		r.titleMu.Lock()
		if r.claudeTitles == nil || len(r.claudeTitles) >= maxTraceCacheEntries {
			r.claudeTitles = make(map[string]claudeTitleCacheEntry)
		}
		r.claudeTitles[cacheKey] = claudeTitleCacheEntry{info: info, title: title}
		r.titleMu.Unlock()
	}
	return title, true
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
		// Once the first request is known, only title metadata can change the
		// result. Avoid decoding megabytes of tool output just to discard it.
		// A Unicode escape could encode any of these type values; it always
		// falls through. A match is only a hint: the original decoder still
		// verifies the complete record, flags and exact session identity.
		if !bytes.Contains(line, []byte(`"ai-title"`)) && !bytes.Contains(line, []byte(`"custom-title"`)) &&
			(!(prompts && s.prompt == "") || !bytes.Contains(line, []byte(`"user"`))) &&
			!bytes.Contains(line, []byte(`\u`)) {
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
