package journal

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	ErrAmbiguous      = errors.New("ambiguous transcript id")
	errUnreadable     = errors.New("transcript unreadable")
	ErrCursorInvalid  = errors.New("invalid history cursor")
	ErrCursorConflict = errors.New("history cursor conflicts with pane session")
)

// Reason says why a transcript cannot be read, without naming any path or id.
type Reason string

const (
	ReasonNotFound   Reason = "not_found"
	ReasonAmbiguous  Reason = "ambiguous"
	ReasonUnreadable Reason = "unreadable"
)

// UnavailableReason gives the reason of an error from Supports-bound reads.
// ok is false for an error that is not about the transcript being unavailable.
func UnavailableReason(err error) (reason Reason, ok bool) {
	switch {
	case errors.Is(err, ErrAmbiguous):
		return ReasonAmbiguous, true
	case errors.Is(err, errUnreadable):
		return ReasonUnreadable, true
	case errors.Is(err, ErrUnavailable):
		return ReasonNotFound, true
	}
	return "", false
}

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

	// ClaudeRoots and CodexRoots are searched after ClaudeRoot and CodexRoot.
	ClaudeRoots []string
	CodexRoots  []string

	indexMu       sync.Mutex
	traceMu       sync.Mutex
	piMu          sync.Mutex
	activityMu    sync.Mutex
	activityCache map[string]activityCacheEntry
	traceCache    map[traceCacheKey]traceCacheEntry
	piCache       []piCacheEntry
	piCacheTick   uint64
	rootIndexes   map[string]*codexFileIndex
	piIndex       piFileIndex
	now           func() time.Time
	walkDir       func(string, fs.WalkDirFunc) error
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
	// cmd/pairfob refuses a bad value at start; a bad one here adds no roots.
	claudeRoots, _ := ParseRoots("PAIRFOB_CLAUDE_ROOTS", os.Getenv("PAIRFOB_CLAUDE_ROOTS"))
	codexRoots, _ := ParseRoots("PAIRFOB_CODEX_ROOTS", os.Getenv("PAIRFOB_CODEX_ROOTS"))
	return &Reader{CodexRoot: codexRoot, ClaudeRoot: claudeRoot, GrokRoot: grokRoot, PiRoot: piRoot, ClaudeRoots: claudeRoots, CodexRoots: codexRoots}
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

	path, err := r.transcriptPath(ref, true)
	if err != nil {
		return Page{}, err
	}
	parse := parseGrok
	switch ref.Agent {
	case "codex":
		parse = parseCodex
	case "claude":
		parse = newClaudeParser()
	}
	return readPage(path, ref, offset, limit, parse)
}

// TranscriptPath names the transcript file the trusted binding resolves to
// without rescanning for a missing one. The watch of an open conversation
// uses it to stat the file.
func (r *Reader) TranscriptPath(ref Ref) (string, error) {
	if !r.Supports(ref) {
		return "", ErrUnavailable
	}
	if ref.Agent == "pi" {
		return r.findPiTranscript(ref, false)
	}
	return r.transcriptPath(ref, false)
}

func (r *Reader) transcriptPath(ref Ref, refreshMissing bool) (string, error) {
	path, _, err := r.transcriptPathBase(ref, refreshMissing)
	return path, err
}

// transcriptPathBase also names the transcript directory of the root that
// holds the file; it is empty for agents without several roots.
func (r *Reader) transcriptPathBase(ref Ref, refreshMissing bool) (string, string, error) {
	var (
		path string
		base string
		err  error
	)
	switch ref.Agent {
	case "codex", "claude":
		path, base, err = r.findTranscript(ref.Agent, ref.Value, refreshMissing)
	case "pi":
		path, err = r.findPiTranscript(ref, refreshMissing)
	default:
		path, err = findGrokTranscript(r.GrokRoot, ref.Value)
	}
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, ErrUnavailable) {
			return "", "", ErrUnavailable
		}
		return "", "", err
	}
	return path, base, nil
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
			return codexMatch{err: ErrAmbiguous}
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
			return codexMatch{err: ErrAmbiguous}
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

func readPage(path string, ref Ref, offset, limit int, parse func([]byte) (Message, bool)) (Page, error) {
	file, err := os.Open(path)
	if err != nil {
		return Page{}, fmt.Errorf("%w: %w", ErrUnavailable, errUnreadable)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Page{}, err
	}
	if offset < 0 || int64(offset) > info.Size() {
		return Page{}, errors.New("invalid history cursor offset")
	}
	if _, err := file.Seek(int64(offset), 0); err != nil {
		return Page{}, err
	}

	page := Page{Messages: make([]Message, 0, limit)}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), maxTranscriptLine)
	position := offset
	scannedBytes := 0
	pageBytes := 0
	more := false
	for scanner.Scan() {
		lineStart := position
		lineBytes := len(scanner.Bytes()) + 1
		position += lineBytes
		scannedBytes += lineBytes
		if scannedBytes > maxScanBytes {
			return Page{}, errors.New("transcript scan exceeds per-request bound")
		}
		message, ok := parse(scanner.Bytes())
		if !ok {
			continue
		}
		message, page.Truncated = clipMessage(message, page.Truncated)
		size := messageSize(message)
		if len(page.Messages) >= limit || (len(page.Messages) > 0 && pageBytes+size > maxPageItemsBytes) {
			more = true
			position = lineStart
			break
		}
		pageBytes += size
		page.Messages = append(page.Messages, message)
	}
	if err := scanner.Err(); err != nil {
		return Page{}, err
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
		if (content.Type == "input_text" || content.Type == "output_text") && content.Text != "" {
			parts = append(parts, content.Text)
		}
	}
	if len(parts) == 0 {
		return Message{}, false
	}
	return Message{Role: item.Payload.Role, Text: strings.Join(parts, "\n")}, true
}

// newClaudeParser returns a parser that also drops a user entry repeating a
// queued prompt shown a moment before.
func newClaudeParser() func([]byte) (Message, bool) {
	dedup := newClaudeDedup()
	return func(line []byte) (Message, bool) { return parseClaudeWith(line, dedup) }
}

func parseClaude(line []byte) (Message, bool) { return parseClaudeWith(line, nil) }

func parseClaudeWith(line []byte, dedup *claudeDedup) (Message, bool) {
	var item struct {
		Type           string           `json:"type"`
		IsMeta         bool             `json:"isMeta"`
		CompactSummary bool             `json:"isCompactSummary"`
		TranscriptOnly bool             `json:"isVisibleInTranscriptOnly"`
		Origin         claudeOrigin     `json:"origin"`
		Timestamp      string           `json:"timestamp"`
		Attachment     claudeAttachment `json:"attachment"`
		Message        struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &item) != nil {
		return Message{}, false
	}
	if item.Type == "attachment" {
		text, at, ok := claudeQueuedPrompt(item.Attachment)
		if !ok || (dedup != nil && dedup.seenQueued(text, at)) {
			return Message{}, false
		}
		return Message{Role: "user", Text: text}, true
	}
	if (item.Type != "user" && item.Type != "assistant") || item.Message.Role != item.Type {
		return Message{}, false
	}
	if item.Type == "user" && !claudeUserEntryShown(item.IsMeta, item.CompactSummary, item.TranscriptOnly, item.Origin) {
		return Message{}, false
	}
	var text string
	if json.Unmarshal(item.Message.Content, &text) == nil {
		if text == "" || (item.Type == "user" && claudeInjectedText(text)) {
			return Message{}, false
		}
		return claudeUserMessage(item.Type, text, item.Timestamp, dedup)
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
			if item.Type == "user" && claudeInjectedText(block.Text) {
				continue
			}
			parts = append(parts, block.Text)
		case item.Type == "assistant" && block.Type == "tool_use" && toolName.MatchString(block.Name):
			parts = append(parts, "工具 · "+block.Name)
		}
	}
	if len(parts) == 0 {
		return Message{}, false
	}
	return claudeUserMessage(item.Type, strings.Join(parts, "\n"), item.Timestamp, dedup)
}

func claudeUserMessage(role, text, timestamp string, dedup *claudeDedup) (Message, bool) {
	if role == "user" && dedup != nil && dedup.seenUser(text, parseClaudeTime(timestamp)) {
		return Message{}, false
	}
	return Message{Role: role, Text: text}, true
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
			} `json:"update"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &update) != nil || update.Method != "session/update" || update.Params.Update.Content.Type != "text" || update.Params.Update.Content.Text == "" {
		return Message{}, false
	}
	role := ""
	switch update.Params.Update.SessionUpdate {
	case "user_message_chunk":
		role = "user"
	case "agent_message_chunk":
		role = "assistant"
	default:
		return Message{}, false
	}
	return Message{Role: role, Text: update.Params.Update.Content.Text}, true
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
