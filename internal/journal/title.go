package journal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Title is display-only metadata for an already trusted native session binding.
// Prompt is an excerpt of the first real request, never the latest follow-up.
type Title struct {
	Name   string
	Prompt string
}

const titleReadBytes = 4 << 20

var codexStateFile = regexp.MustCompile(`^state_([0-9]+)\.sqlite$`)

// ReadTitle never discovers a session by cwd or recency. Missing metadata stays
// empty. The short bounded cache also lets a name generated later replace the
// prompt excerpt without reading the native store on every terminal frame.
func (r *Reader) ReadTitle(ref Ref) Title {
	if !r.Supports(ref) {
		return Title{}
	}
	switch ref.Agent {
	case "claude":
		return r.cachedTitle(r.ClaudeRoot, ref, r.claudeTitle)
	case "codex":
		return r.cachedTitle(r.CodexRoot, ref, r.codexTitle)
	case "pi", "prime-agent":
		return r.cachedTitle(r.piSessionsDir(ref.Agent), ref, r.piTitle)
	case "grok":
		return r.cachedTitle(r.GrokRoot, ref, r.grokTitle)
	case "cursor":
		return r.cachedTitle(r.CursorRoot, ref, r.lineTitle)
	case "hermes":
		return r.cachedTitle(r.HermesRoot, ref, r.hermesTitle)
	case "kilo":
		return r.cachedTitle(r.NativeRoots[ref.Agent], ref, r.kiloTitle)
	case "opencode":
		return r.cachedTitle(r.OpencodeRoot, ref, r.opencodeTitle)
	case "cmd", "gemini", "qwen", "cline", "amp", "droid", "maki", "agy", "letta", "qodercli", "kiro", "devin", "kimi":
		return r.cachedTitle(r.NativeRoots[ref.Agent], ref, r.nativeStoreTitle)
	case "muse":
		return r.cachedTitle(r.NativeRoots[ref.Agent], ref, r.museTitle)
	case "copilot":
		return r.cachedTitle(r.NativeRoots[ref.Agent], ref, r.nativeLineTitle)
	default:
		return Title{}
	}
}

func (r *Reader) codexTitle(ref Ref) (Title, bool) {
	title, stored := r.codexStoredTitle(ref.Value)
	if title.Prompt == "" {
		title.Prompt = r.codexFirstPrompt(ref)
	}
	return title, stored
}

// piTitle reads the name `/name` stored and, failing that, the first request on
// the active branch. Pi resolves the current name from the newest session_info
// in file order, including an explicit clear, not from the active branch.
func (r *Reader) piTitle(ref Ref) (Title, bool) {
	session, err := r.loadPiSession(ref, false)
	if err != nil {
		return Title{}, false
	}
	title := Title{Prompt: piFirstPrompt(session)}
	for i := len(session.order) - 1; i >= 0; i-- {
		if entry := session.entries[session.order[i]]; entry.Type == "session_info" {
			title.Name = titleText(entry.Name, 256)
			break
		}
	}
	return title, true
}

func piFirstPrompt(session *piSession) string {
	for _, entry := range session.branch {
		if entry.Type != "message" {
			continue
		}
		var message piMessage
		if json.Unmarshal(entry.Message, &message) != nil || message.Role != "user" {
			continue
		}
		if prompt := promptTitle(piUserText(message.Content)); prompt != "" {
			return prompt
		}
	}
	return ""
}

func (r *Reader) codexStoredTitle(id string) (Title, bool) {
	files, _ := filepath.Glob(filepath.Join(r.CodexRoot, "state_*.sqlite"))
	latest, version := "", -1
	for _, file := range files {
		match := codexStateFile.FindStringSubmatch(filepath.Base(file))
		if match == nil {
			continue
		}
		n, err := strconv.Atoi(match[1])
		if err == nil && n > version {
			latest, version = file, n
		}
	}
	db, err := verifiedRegular(r.CodexRoot, latest)
	if latest == "" || err != nil {
		return Title{}, false
	}
	query := r.sqlite
	if query == nil {
		query = runSQLite
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	// Supports matched the ID against sessionID; it cannot contain an SQL quote.
	// 'title' is intentionally omitted: older Codex versions put raw prompts and
	// injected context there. 'name' is the explicitly saved/generated name.
	reply, err := query(ctx, db, fmt.Sprintf("select id, substr(name,1,256) as name, substr(first_user_message,1,65536) as prompt from threads where id='%s' limit 1;", id))
	var rows []struct{ ID, Name, Prompt string }
	if err != nil || len(reply) > maxMessageBytes*6 || json.Unmarshal(reply, &rows) != nil {
		return Title{}, false
	}
	if len(rows) == 0 {
		return Title{}, true
	}
	if len(rows) != 1 || rows[0].ID != id {
		return Title{}, false
	}
	return Title{Name: titleText(rows[0].Name, 256), Prompt: promptTitle(rows[0].Prompt)}, true
}

func (r *Reader) codexFirstPrompt(ref Ref) string {
	path, err := r.transcriptPath(ref, false)
	if err != nil {
		return ""
	}
	file, err := openActivityFile(r.transcriptBase(ref.Agent), path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(io.LimitReader(file, titleReadBytes))
	scanner.Buffer(make([]byte, 4096), maxTranscriptLine)
	for scanner.Scan() {
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				Type, Message string
			} `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) == nil && record.Type == "event_msg" && record.Payload.Type == "user_message" {
			if title := promptTitle(record.Payload.Message); title != "" {
				return title
			}
		}
		if message, ok := parseCodex(scanner.Bytes()); ok && message.Role == "user" {
			if title := promptTitle(message.Text); title != "" {
				return title
			}
		}
	}
	return ""
}

// Pairfob's legacy attachment prefix is a local file path. Never turn that path
// into a task name; the request immediately following it is the useful text.
var titleAttachment = regexp.MustCompile(`(?:\S*/)?\.pairfob/attachments/[^\s]+`)

func promptTitle(text string) string {
	text = visibleCodexUserText(text)
	text = titleAttachment.ReplaceAllString(text, "")
	text = strings.TrimSpace(text)
	if text == "" || strings.HasPrefix(text, "/") || strings.HasPrefix(text, "<") || strings.HasPrefix(text, "# AGENTS.md") {
		return ""
	}
	return titleText(text, 72)
}

func titleText(text string, limit int) string {
	text = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, text)
	runes := []rune(strings.Join(strings.Fields(text), " "))
	if len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return string(runes)
}
