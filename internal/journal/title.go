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

type titleCacheEntry struct {
	at    time.Time
	value Title
}

const titleReadBytes = 4 << 20

var codexStateFile = regexp.MustCompile(`^state_([0-9]+)\.sqlite$`)

// ReadTitle never discovers a session by cwd or recency. Missing metadata stays
// empty. The short bounded cache also lets a name generated later replace the
// prompt excerpt without reading SQLite on every terminal frame.
func (r *Reader) ReadTitle(ref Ref) Title {
	if ref.Agent != "codex" || !r.Supports(ref) {
		return Title{}
	}
	now := time.Now()
	if r.now != nil {
		now = r.now()
	}
	r.titleMu.Lock()
	defer r.titleMu.Unlock()
	key := refFingerprint(ref)
	if entry, ok := r.titleCache[key]; ok && now.Sub(entry.at) < 2*time.Second {
		return entry.value
	}
	title := r.codexStoredTitle(ref.Value)
	if title.Prompt == "" {
		title.Prompt = r.codexFirstPrompt(ref)
	}
	if r.titleCache == nil || len(r.titleCache) >= maxTraceCacheEntries {
		r.titleCache = make(map[string]titleCacheEntry)
	}
	r.titleCache[key] = titleCacheEntry{at: now, value: title}
	return title
}

func (r *Reader) codexStoredTitle(id string) Title {
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
		return Title{}
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
	if err != nil || len(reply) > maxMessageBytes*6 || json.Unmarshal(reply, &rows) != nil || len(rows) != 1 || rows[0].ID != id {
		return Title{}
	}
	return Title{Name: titleText(rows[0].Name, 256), Prompt: promptTitle(rows[0].Prompt)}
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
