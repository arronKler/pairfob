package journal

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Activity is evidence of an actual prompt or model execution in a trusted
// native transcript. A launch, session header, or injected instructions are
// not a task. Key identifies the latest evidence without exposing its content.
type Activity struct {
	Known bool
	Key   string
	State string
}

const activityReadBytes = 512 << 10

type activityCacheEntry struct {
	info     os.FileInfo
	activity Activity
}

// ReadActivity is bounded and stat-cached for snapshot polling. An unreadable
// or unsupported transcript is unknown, never proof that a task completed.
func (r *Reader) ReadActivity(ref Ref) Activity {
	if !r.Supports(ref) {
		return Activity{}
	}
	path, err := r.transcriptPath(ref, false)
	if err != nil {
		return Activity{}
	}
	base := filepath.Join(r.GrokRoot, "sessions")
	switch ref.Agent {
	case "codex":
		base = filepath.Join(r.CodexRoot, "sessions")
	case "claude":
		base = filepath.Join(r.ClaudeRoot, "projects")
	case "pi":
		base = filepath.Join(r.PiRoot, "sessions")
	}
	file, err := openActivityFile(base, path)
	if err != nil {
		return Activity{}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Activity{}
	}
	// Serialize cache misses so the monitor and phone snapshot share the work.
	r.activityMu.Lock()
	defer r.activityMu.Unlock()
	cacheKey := ref.Agent + "\x00" + path
	if cached, ok := r.activityCache[cacheKey]; ok && os.SameFile(info, cached.info) &&
		info.Size() == cached.info.Size() && info.ModTime() == cached.info.ModTime() {
		return cached.activity
	}
	var activity Activity
	if ref.Agent == "pi" {
		activity = r.piActivity(ref)
	} else {
		start := max(int64(0), info.Size()-activityReadBytes)
		data := make([]byte, info.Size()-start)
		if _, err := file.ReadAt(data, start); err != nil && err != io.EOF {
			return Activity{}
		}
		activity = scanActivity(ref.Agent, data, start)
	}
	after, err := file.Stat()
	if err != nil || after.Size() != info.Size() || after.ModTime() != info.ModTime() {
		return Activity{}
	}
	if r.activityCache == nil || len(r.activityCache) >= maxTraceCacheEntries {
		r.activityCache = make(map[string]activityCacheEntry)
	}
	r.activityCache[cacheKey] = activityCacheEntry{info: info, activity: activity}
	return activity
}

func scanActivity(agent string, data []byte, offset int64) Activity {
	activity := Activity{Known: offset == 0}
	if offset > 0 {
		// The first line may start outside the bounded tail.
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			return Activity{}
		}
		offset += int64(end + 1)
		data = data[end+1:]
	}
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			// A writer may still be appending this record.
			activity.Known = activity.Key != ""
			break
		}
		line := data[:end]
		if !json.Valid(line) && len(bytes.TrimSpace(line)) > 0 {
			activity.Known = false
		} else if activityLine(agent, line) {
			activity.Known = true
			activity.Key = activityKey(strconv.FormatInt(offset, 10), line)
			if agent == "codex" {
				if state := codexActivityState(line); state != "" {
					activity.State = state
				}
			}
		}
		offset += int64(end + 1)
		data = data[end+1:]
	}
	return activity
}

func activityLine(agent string, line []byte) bool {
	parse := traceParser(parseGrokTrace)
	switch agent {
	case "codex":
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				Type string `json:"type"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &record) != nil {
			return false
		}
		if record.Type == "event_msg" {
			switch record.Payload.Type {
			case "task_started", "task_complete", "user_message", "turn_aborted":
				return true
			}
		}
		parse = parseCodexTrace
	case "claude":
		parse = parseClaudeTrace
	}
	for _, event := range parse(line) {
		// Codex injects AGENTS.md and environment context as user messages.
		// Its user_message/task_started records identify real submissions.
		if agent == "codex" && event.Type == "user" && codexContextMessage(line) {
			continue
		}
		// Commands and markers are not task evidence: a command that starts
		// work is followed by assistant or tool events, which are.
		switch event.Type {
		case "user", "assistant", "thinking", "tool":
			return true
		}
	}
	return false
}

func codexContextMessage(line []byte) bool {
	var record struct {
		Payload struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil {
		return true
	}
	for _, content := range record.Payload.Content {
		text := strings.TrimSpace(content.Text)
		if text == "" {
			continue
		}
		context := false
		for _, prefix := range []string{"# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<developer_instructions>", "<INSTRUCTIONS>"} {
			context = context || strings.HasPrefix(text, prefix)
		}
		if !context {
			return false
		}
	}
	return true
}

func codexActivityState(line []byte) string {
	var record struct {
		Type    string `json:"type"`
		Payload struct {
			Type string `json:"type"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &record) != nil || record.Type != "event_msg" {
		return ""
	}
	switch record.Payload.Type {
	case "task_started", "user_message":
		return "working"
	case "task_complete", "turn_aborted":
		return "done"
	}
	return ""
}

// Confine periodic reads to the provider root even if a file is replaced
// between lookup and open. Nonblocking opens also reject FIFO substitutions.
func openActivityFile(base, path string) (*os.File, error) {
	base, err := filepath.EvalSymlinks(base)
	if err != nil {
		return nil, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(base, path)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	pre, err := root.Lstat(relative)
	if err != nil || !pre.Mode().IsRegular() {
		return nil, ErrUnavailable
	}
	file, err := root.OpenFile(relative, os.O_RDONLY|activityOpenFlags(), 0)
	if err != nil {
		return nil, err
	}
	post, err := file.Stat()
	if err != nil || !post.Mode().IsRegular() || !os.SameFile(pre, post) {
		file.Close()
		return nil, ErrUnavailable
	}
	return file, nil
}

func activityKey(position string, data []byte) string {
	hash := sha256.New()
	hash.Write([]byte(position + "\x00"))
	hash.Write(data)
	return hex.EncodeToString(hash.Sum(nil))
}

func (r *Reader) piActivity(ref Ref) Activity {
	session, err := r.loadPiSession(ref, false)
	if err != nil {
		return Activity{}
	}
	// Follow the active branch; extension welcome messages are not task output.
	for i := len(session.branch) - 1; i >= 0; i-- {
		entry := session.branch[i]
		if entry.Type != "message" {
			continue
		}
		var message piMessage
		if json.Unmarshal(entry.Message, &message) != nil {
			continue
		}
		switch message.Role {
		case "user", "assistant", "toolResult":
			return Activity{Known: true, Key: activityKey(session.id+":"+entry.ID, entry.Message)}
		}
	}
	return Activity{Known: true}
}
