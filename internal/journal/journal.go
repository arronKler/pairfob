package journal

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxTranscriptLine = 2 << 20
	maxMessageBytes   = 64 << 10
	maxPageBytes      = 220 << 10
	maxPageItemsBytes = maxPageBytes - (4 << 10)
	maxScanBytes      = 32 << 20
	maxWalkEntries    = 100_000
	// Snapshot polling reuses one bounded filesystem index. Missing IDs refresh
	// sooner, while an explicit History read refreshes them immediately.
	codexIndexTTL    = 30 * time.Second
	codexNegativeTTL = 5 * time.Second
)

var sessionID = regexp.MustCompile(`^[0-9A-Za-z_-]{8,128}$`)
var toolName = regexp.MustCompile(`^[0-9A-Za-z_.:-]{1,128}$`)

var (
	ErrUnavailable    = errors.New("transcript unavailable")
	ErrCursorInvalid  = errors.New("invalid history cursor")
	ErrCursorConflict = errors.New("history cursor conflicts with pane session")
)

// Ref is a trusted pane-to-agent-session binding reported by Herdr. Callers
// must never construct it from phone-supplied transcript identifiers.
type Ref struct {
	Source string
	Agent  string
	Kind   string
	Value  string
}

type Message struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type Page struct {
	Messages   []Message `json:"messages"`
	NextCursor *string   `json:"next_cursor"`
	Truncated  bool      `json:"truncated"`
}

type Reader struct {
	CodexRoot  string
	ClaudeRoot string
	GrokRoot   string
	PiRoot     string
	CursorRoot string
	// HermesRoot holds state.db; OpencodeRoot holds storage/.
	HermesRoot   string
	OpencodeRoot string

	indexMu       sync.Mutex
	traceMu       sync.Mutex
	piMu          sync.Mutex
	activityMu    sync.Mutex
	activityCache map[string]activityCacheEntry
	traceCache    map[traceCacheKey]traceCacheEntry
	piCache       []piCacheEntry
	storeMu       sync.Mutex
	storeCache    map[string]*storeEntry
	storeTick     uint64
	// sqlite runs one read-only query; nil uses the system sqlite3.
	sqlite      func(ctx context.Context, db, sql string) ([]byte, error)
	piCacheTick uint64
	codexIndex  codexFileIndex
	claudeIndex codexFileIndex
	piIndex     piFileIndex
	now         func() time.Time
	walkDir     func(string, fs.WalkDirFunc) error
}

type codexFileIndex struct {
	root      string
	scannedAt time.Time
	files     []string
	err       error
	matches   map[string]codexMatch
}

type codexMatch struct {
	path string
	err  error
}

func NewDefault() *Reader {
	home, _ := os.UserHomeDir()
	codexRoot := os.Getenv("CODEX_HOME")
	if codexRoot == "" {
		codexRoot = filepath.Join(home, ".codex")
	}
	grokRoot := os.Getenv("GROK_HOME")
	if grokRoot == "" {
		grokRoot = filepath.Join(home, ".grok")
	}
	claudeRoot := os.Getenv("CLAUDE_CONFIG_DIR")
	if claudeRoot == "" {
		claudeRoot = filepath.Join(home, ".claude")
	}
	piRoot := os.Getenv("PI_CODING_AGENT_DIR")
	if piRoot == "" {
		piRoot = filepath.Join(home, ".pi", "agent")
	}
	hermesRoot := os.Getenv("HERMES_HOME")
	if hermesRoot == "" {
		hermesRoot = filepath.Join(home, ".hermes")
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	return &Reader{
		CodexRoot: codexRoot, ClaudeRoot: claudeRoot, GrokRoot: grokRoot, PiRoot: piRoot,
		CursorRoot: filepath.Join(home, ".cursor"), HermesRoot: hermesRoot, OpencodeRoot: filepath.Join(dataHome, "opencode"),
	}
}

func (r *Reader) Supports(ref Ref) bool {
	if ref.Source == "herdr:pi" && ref.Agent == "pi" && r.PiRoot != "" {
		return (ref.Kind == "id" && sessionID.MatchString(ref.Value)) ||
			(ref.Kind == "path" && piPathSyntax(r.PiRoot, ref.Value))
	}
	if ref.Kind != "id" || !sessionID.MatchString(ref.Value) {
		return false
	}
	switch {
	case ref.Source == "herdr:codex" && ref.Agent == "codex":
		return r.CodexRoot != ""
	case ref.Source == "herdr:claude" && ref.Agent == "claude":
		return r.ClaudeRoot != ""
	case ref.Source == "herdr:grok" && ref.Agent == "grok":
		return r.GrokRoot != ""
	case ref.Source == "herdr:cursor" && ref.Agent == "cursor":
		return r.CursorRoot != ""
	case ref.Source == "herdr:hermes" && ref.Agent == "hermes":
		return r.HermesRoot != ""
	case ref.Source == "herdr:opencode" && ref.Agent == "opencode":
		return r.OpencodeRoot != ""
	default:
		return false
	}
}

// Available verifies that the trusted binding currently resolves to one safe,
// regular transcript. Supports alone only identifies a configured adapter.
func (r *Reader) Available(ref Ref) bool {
	if !r.Supports(ref) {
		return false
	}
	if ref.Agent == "pi" {
		_, err := r.loadPiSession(ref, false)
		return err == nil
	}
	if storeAgent(ref.Agent) {
		_, err := r.loadStore(ref, false)
		return err == nil
	}
	_, err := r.transcriptPath(ref, false)
	return err == nil
}

func (r *Reader) Read(ref Ref, cursor *string, limit int) (Page, error) {
	if !r.Supports(ref) {
		return Page{}, ErrUnavailable
	}
	if ref.Agent == "pi" {
		return r.readPiHistory(ref, cursor, limit)
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 200 {
		return Page{}, errors.New("invalid history limit")
	}
	offset, err := decodeCursor(ref, cursor)
	if err != nil {
		return Page{}, err
	}

	source, err := r.openTranscript(ref, true)
	if err != nil {
		return Page{}, err
	}
	defer source.Close()
	return readPage(source, ref, offset, limit, historyParserFor(ref.Agent))
}

func (r *Reader) transcriptPath(ref Ref, refreshMissing bool) (string, error) {
	var (
		path string
		err  error
	)
	switch ref.Agent {
	case "codex":
		path, err = r.findCodexTranscript(ref.Value, refreshMissing)
	case "claude":
		path, err = r.findClaudeTranscript(ref.Value, refreshMissing)
	case "pi":
		path, err = r.findPiTranscript(ref, refreshMissing)
	case "cursor":
		path, err = findCursorTranscript(r.CursorRoot, ref.Value)
	default:
		path, err = findGrokTranscript(r.GrokRoot, ref.Value)
	}
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, ErrUnavailable) {
			return "", ErrUnavailable
		}
		return "", err
	}
	return path, nil
}

func (r *Reader) findClaudeTranscript(id string, refreshMissing bool) (string, error) {
	r.indexMu.Lock()
	now := time.Now()
	if r.now != nil {
		now = r.now()
	}
	refreshed := false
	if r.claudeIndex.root != r.ClaudeRoot || r.claudeIndex.scannedAt.IsZero() || now.Sub(r.claudeIndex.scannedAt) >= codexIndexTTL || (r.claudeIndex.err != nil && now.Sub(r.claudeIndex.scannedAt) >= codexNegativeTTL) {
		r.rebuildClaudeIndexLocked(now)
		refreshed = true
	}
	match, known := r.claudeIndex.matches[id]
	if known && !refreshed && errors.Is(match.err, ErrUnavailable) && (refreshMissing || now.Sub(r.claudeIndex.scannedAt) >= codexNegativeTTL) {
		r.rebuildClaudeIndexLocked(now)
		refreshed = true
		known = false
	}
	if !known {
		match = matchClaudeTranscript(r.claudeIndex.files, id, r.claudeIndex.err)
		if !refreshed && errors.Is(match.err, ErrUnavailable) && (refreshMissing || now.Sub(r.claudeIndex.scannedAt) >= codexNegativeTTL) {
			r.rebuildClaudeIndexLocked(now)
			match = matchClaudeTranscript(r.claudeIndex.files, id, r.claudeIndex.err)
		}
		r.claudeIndex.matches[id] = match
	}
	r.indexMu.Unlock()
	if match.err != nil {
		return "", match.err
	}
	return verifiedRegular(filepath.Join(r.ClaudeRoot, "projects"), match.path)
}

func (r *Reader) rebuildClaudeIndexLocked(now time.Time) {
	walk := r.walkDir
	if walk == nil {
		walk = filepath.WalkDir
	}
	files, err := scanTranscriptFiles(filepath.Join(r.ClaudeRoot, "projects"), walk)
	r.claudeIndex = codexFileIndex{
		root: r.ClaudeRoot, scannedAt: now, files: files, err: err,
		matches: make(map[string]codexMatch),
	}
}

func (r *Reader) findCodexTranscript(id string, refreshMissing bool) (string, error) {
	r.indexMu.Lock()
	now := time.Now()
	if r.now != nil {
		now = r.now()
	}
	refreshed := false
	if r.codexIndex.root != r.CodexRoot || r.codexIndex.scannedAt.IsZero() || now.Sub(r.codexIndex.scannedAt) >= codexIndexTTL || (r.codexIndex.err != nil && now.Sub(r.codexIndex.scannedAt) >= codexNegativeTTL) {
		r.rebuildCodexIndexLocked(now)
		refreshed = true
	}
	match, known := r.codexIndex.matches[id]
	if known && !refreshed && errors.Is(match.err, ErrUnavailable) && (refreshMissing || now.Sub(r.codexIndex.scannedAt) >= codexNegativeTTL) {
		r.rebuildCodexIndexLocked(now)
		refreshed = true
		known = false
	}
	if !known {
		match = matchCodexTranscript(r.codexIndex.files, id, r.codexIndex.err)
		if !refreshed && errors.Is(match.err, ErrUnavailable) && (refreshMissing || now.Sub(r.codexIndex.scannedAt) >= codexNegativeTTL) {
			r.rebuildCodexIndexLocked(now)
			match = matchCodexTranscript(r.codexIndex.files, id, r.codexIndex.err)
		}
		r.codexIndex.matches[id] = match
	}
	r.indexMu.Unlock()
	if match.err != nil {
		return "", match.err
	}
	return verifiedRegular(filepath.Join(r.CodexRoot, "sessions"), match.path)
}

func (r *Reader) rebuildCodexIndexLocked(now time.Time) {
	walk := r.walkDir
	if walk == nil {
		walk = filepath.WalkDir
	}
	files, err := scanCodexTranscripts(r.CodexRoot, walk)
	r.codexIndex = codexFileIndex{
		root: r.CodexRoot, scannedAt: now, files: files, err: err,
		matches: make(map[string]codexMatch),
	}
}

func scanCodexTranscripts(root string, walk func(string, fs.WalkDirFunc) error) ([]string, error) {
	return scanTranscriptFiles(filepath.Join(root, "sessions"), walk)
}

func scanTranscriptFiles(base string, walk func(string, fs.WalkDirFunc) error) ([]string, error) {
	if _, err := os.Stat(base); err != nil {
		if os.IsNotExist(err) {
			return nil, ErrUnavailable
		}
		return nil, err
	}
	files := make([]string, 0, 256)
	seen := 0
	err := walk(base, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		seen++
		if seen > maxWalkEntries {
			return errors.New("transcript index is too large")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".jsonl") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

func matchClaudeTranscript(files []string, id string, indexErr error) codexMatch {
	if indexErr != nil {
		return codexMatch{err: indexErr}
	}
	wanted := id + ".jsonl"
	match := ""
	for _, path := range files {
		if filepath.Base(path) != wanted {
			continue
		}
		if match != "" {
			return codexMatch{err: errors.New("ambiguous transcript id")}
		}
		match = path
	}
	if match == "" {
		return codexMatch{err: ErrUnavailable}
	}
	return codexMatch{path: match}
}

func matchCodexTranscript(files []string, id string, indexErr error) codexMatch {
	if indexErr != nil {
		return codexMatch{err: indexErr}
	}
	suffix := "-" + id + ".jsonl"
	match := ""
	for _, path := range files {
		if !strings.HasSuffix(filepath.Base(path), suffix) {
			continue
		}
		if match != "" {
			return codexMatch{err: errors.New("ambiguous transcript id")}
		}
		match = path
	}
	if match == "" {
		return codexMatch{err: ErrUnavailable}
	}
	return codexMatch{path: match}
}

func findGrokTranscript(root, id string) (string, error) {
	base := filepath.Join(root, "sessions")
	matches, err := filepath.Glob(filepath.Join(base, "*", id, "updates.jsonl"))
	if err != nil {
		return "", err
	}
	if len(matches) != 1 {
		return "", ErrUnavailable
	}
	return verifiedRegular(base, matches[0])
}

func verifiedRegular(root, path string) (string, error) {
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	pathReal, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootReal, pathReal)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", ErrUnavailable
	}
	info, err := os.Stat(pathReal)
	if err != nil || !info.Mode().IsRegular() {
		return "", ErrUnavailable
	}
	return pathReal, nil
}

func readPage(source *transcript, ref Ref, offset, limit int, parse func([]byte) (Message, bool)) (Page, error) {
	if offset < 0 || int64(offset) > source.size {
		return Page{}, errors.New("invalid history cursor offset")
	}

	page := Page{Messages: make([]Message, 0, limit)}
	position := offset
	scannedBytes := 0
	pageBytes := 0
	more := false
	overBudget := false
	err := forEachLine(source.from(int64(offset)), maxTraceLine, func(line []byte, lineBytes int, oversized bool) bool {
		lineStart := position
		position += lineBytes
		scannedBytes += lineBytes
		if scannedBytes > maxScanBytes {
			overBudget = true
			return false
		}
		if oversized {
			page.Truncated = true
			return true
		}
		message, ok := parse(line)
		if !ok {
			return true
		}
		message, page.Truncated = clipMessage(message, page.Truncated)
		size := messageSize(message)
		if len(page.Messages) >= limit || (len(page.Messages) > 0 && pageBytes+size > maxPageItemsBytes) {
			more = true
			position = lineStart
			return false
		}
		pageBytes += size
		page.Messages = append(page.Messages, message)
		return true
	})
	if err != nil {
		return Page{}, err
	}
	if overBudget {
		return Page{}, errors.New("transcript scan exceeds per-request bound")
	}
	if more {
		next := encodeCursor(ref, position)
		page.NextCursor = &next
	}
	return page, nil
}

func messageSize(message Message) int {
	encoded, err := json.Marshal(message)
	if err != nil {
		return maxPageItemsBytes + 1
	}
	return len(encoded)
}

func clipMessage(message Message, truncated bool) (Message, bool) {
	message.Text, truncated = clip(message.Text, maxMessageBytes, truncated)
	for messageSize(message) > maxMessageBytes {
		message.Text, _ = clip(message.Text, len(message.Text)/2, false)
		truncated = true
	}
	return message, truncated
}

func parseCodex(line []byte) (Message, bool) {
	var item struct {
		Type    string `json:"type"`
		Payload struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Name    string `json:"name"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &item) != nil || item.Type != "response_item" {
		return Message{}, false
	}
	if (item.Payload.Type == "function_call" || item.Payload.Type == "custom_tool_call") && toolName.MatchString(item.Payload.Name) {
		return Message{Role: "assistant", Text: "工具 · " + item.Payload.Name}, true
	}
	if item.Payload.Type != "message" || (item.Payload.Role != "user" && item.Payload.Role != "assistant") {
		return Message{}, false
	}
	parts := make([]string, 0, len(item.Payload.Content))
	for _, content := range item.Payload.Content {
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
	if len(parts) == 0 {
		return Message{}, false
	}
	return Message{Role: item.Payload.Role, Text: strings.Join(parts, "\n")}, true
}

func parseClaude(line []byte) (Message, bool) {
	var item struct {
		claudeRecordFlags
		Type    string `json:"type"`
		Message struct {
			Role    string          `json:"role"`
			Model   string          `json:"model"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &item) != nil || (item.Type != "user" && item.Type != "assistant") || item.Message.Role != item.Type {
		return Message{}, false
	}
	if item.hidden() || item.syntheticPlaceholder(item.Message.Model) {
		return Message{}, false
	}
	var text string
	if json.Unmarshal(item.Message.Content, &text) == nil {
		if item.Type == "user" {
			text = visibleClaudeUserText(text)
		}
		if text == "" {
			return Message{}, false
		}
		return Message{Role: item.Type, Text: text}, true
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
		Name string `json:"name"`
	}
	if json.Unmarshal(item.Message.Content, &blocks) != nil {
		return Message{}, false
	}
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		switch {
		case block.Type == "text" && block.Text != "":
			text := block.Text
			if item.Type == "user" {
				text = visibleClaudeUserText(text)
			}
			if text != "" {
				parts = append(parts, text)
			}
		case item.Type == "assistant" && block.Type == "tool_use" && toolName.MatchString(block.Name):
			parts = append(parts, "工具 · "+block.Name)
		}
	}
	if len(parts) == 0 {
		return Message{}, false
	}
	return Message{Role: item.Type, Text: strings.Join(parts, "\n")}, true
}

func parseGrok(line []byte) (Message, bool) {
	var update struct {
		Method string `json:"method"`
		Params struct {
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Content       struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
				Meta json.RawMessage `json:"_meta"`
			} `json:"update"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &update) != nil || update.Method != "session/update" || update.Params.Update.Content.Type != "text" || update.Params.Update.Content.Text == "" {
		return Message{}, false
	}
	text := update.Params.Update.Content.Text
	role := ""
	switch update.Params.Update.SessionUpdate {
	case "user_message_chunk":
		role = "user"
		text = visibleGrokUserText(text, update.Params.Update.Meta)
	case "agent_message_chunk":
		role = "assistant"
	default:
		return Message{}, false
	}
	if text == "" {
		return Message{}, false
	}
	return Message{Role: role, Text: text}, true
}

func refFingerprint(ref Ref) string {
	sum := sha256.Sum256([]byte(ref.Source + "\x00" + ref.Agent + "\x00" + ref.Kind + "\x00" + ref.Value))
	return base64.RawURLEncoding.EncodeToString(sum[:12])
}

func encodeCursor(ref Ref, offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(refFingerprint(ref) + ":" + strconv.Itoa(offset)))
}

func decodeCursor(ref Ref, cursor *string) (int, error) {
	if cursor == nil || *cursor == "" {
		return 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(*cursor)
	if err != nil {
		return 0, ErrCursorInvalid
	}
	prefix, offsetText, ok := strings.Cut(string(raw), ":")
	if !ok || prefix != refFingerprint(ref) {
		return 0, ErrCursorConflict
	}
	offset, err := strconv.Atoi(offsetText)
	if err != nil || offset < 0 {
		return 0, ErrCursorInvalid
	}
	return offset, nil
}

func clip(text string, limit int, already bool) (string, bool) {
	if len(text) <= limit {
		return text, already
	}
	bytes := []byte(text[:limit])
	for len(bytes) > 0 && !utf8.Valid(bytes) {
		bytes = bytes[:len(bytes)-1]
	}
	return string(bytes) + "…", true
}
