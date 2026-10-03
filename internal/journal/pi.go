package journal

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxPiCacheBytes = 32 << 20
	// Each parsed entry owns map-bucket/slice slots, a piEntry value, strings,
	// RawMessage copies, and branch membership. Charging 1 KiB per entry in
	// addition to twice the JSONL bytes deliberately overestimates those fixed
	// structures, including allocator and map overhead, for cache admission.
	piCacheEntryOverhead = 1024
)

type piFileIndex struct {
	root      string
	matches   map[string][]string
	scannedAt time.Time
}

type piCacheEntry struct {
	path        string
	info        fs.FileInfo
	digest      [32]byte
	bytes       int
	sourceBytes int
	tick        uint64
	session     *piSession
	sessionID   string
	incarnation string
}

type piSession struct {
	id          string
	incarnation string
	path        string
	entries     map[string]piEntry
	order       []string
	branch      []piEntry
	branchSet   map[string]bool
}

type piEntry struct {
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	ParentID   *string         `json:"parentId"`
	Message    json.RawMessage `json:"message"`
	CustomType string          `json:"customType"`
	Content    json.RawMessage `json:"content"`
	Display    bool            `json:"display"`
	Timestamp  json.RawMessage `json:"timestamp"`
}

type piHeader struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	ID      string `json:"id"`
}

type piMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	IsError    bool            `json:"isError"`
	StopReason string          `json:"stopReason"`
}

type piBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func piPathSyntax(root, value string) bool {
	if !filepath.IsAbs(value) || filepath.Clean(value) != value || filepath.Ext(value) != ".jsonl" {
		return false
	}
	for _, part := range strings.Split(filepath.ToSlash(value), "/") {
		if part == ".." {
			return false
		}
	}
	absRoot, err := filepath.Abs(filepath.Join(root, "sessions"))
	if err != nil {
		return false
	}
	absValue, err := filepath.Abs(value)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absRoot, absValue)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (r *Reader) findPiTranscript(ref Ref, refresh bool) (string, error) {
	root, err := filepath.Abs(filepath.Join(r.PiRoot, "sessions"))
	if err != nil {
		return "", ErrUnavailable
	}
	if ref.Kind == "path" {
		if !piPathSyntax(r.PiRoot, ref.Value) {
			return "", ErrUnavailable
		}
		absolute, err := filepath.Abs(ref.Value)
		if err != nil {
			return "", ErrUnavailable
		}
		lexicalRel, err := filepath.Rel(root, absolute)
		if err != nil || lexicalRel == "." || lexicalRel == ".." || strings.HasPrefix(lexicalRel, ".."+string(filepath.Separator)) {
			return "", ErrUnavailable
		}
		file, err := openPiRegular(root, lexicalRel)
		if err != nil {
			return "", ErrUnavailable
		}
		_ = file.Close()
		return absolute, nil
	}
	if ref.Kind != "id" || !sessionID.MatchString(ref.Value) {
		return "", ErrUnavailable
	}
	r.indexMu.Lock()
	defer r.indexMu.Unlock()
	now := time.Now()
	if r.now != nil {
		now = r.now()
	}
	if r.piIndex.root != root || r.piIndex.matches == nil || now.Sub(r.piIndex.scannedAt) >= codexIndexTTL || (refresh && len(r.piIndex.matches[ref.Value]) != 1) {
		matches := map[string][]string{}
		count := 0
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			count++
			if count > maxWalkEntries {
				return ErrUnavailable
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() || filepath.Ext(path) != ".jsonl" {
				return nil
			}
			info, infoErr := entry.Info()
			if infoErr != nil || !info.Mode().IsRegular() {
				return nil
			}
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return nil
			}
			header, e := readPiHeaderRoot(root, rel)
			if e == nil {
				matches[header.ID] = append(matches[header.ID], path)
			}
			return nil
		})
		if err != nil {
			return "", ErrUnavailable
		}
		r.piIndex = piFileIndex{root: root, matches: matches, scannedAt: now}
	}
	paths := r.piIndex.matches[ref.Value]
	if len(paths) != 1 {
		return "", ErrUnavailable
	}
	return paths[0], nil
}

func openPiRegular(rootPath, relative string) (*os.File, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.Clean(relative) != relative || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, ErrUnavailable
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	parts := strings.Split(relative, string(filepath.Separator))
	for index := range parts {
		name := filepath.Join(parts[:index+1]...)
		info, err := root.Lstat(name)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrUnavailable
		}
		if index == len(parts)-1 {
			// Reject FIFOs/devices/sockets before Open, which could otherwise block.
			if !info.Mode().IsRegular() {
				return nil, ErrUnavailable
			}
		} else if !info.IsDir() {
			return nil, ErrUnavailable
		}
	}
	file, err := root.Open(relative)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, ErrUnavailable
	}
	return file, nil
}

func readPiHeaderRoot(root, relative string) (piHeader, error) {
	file, err := openPiRegular(root, relative)
	if err != nil {
		return piHeader{}, err
	}
	defer file.Close()
	s := bufio.NewScanner(file)
	s.Buffer(make([]byte, 4096), maxTranscriptLine)
	if !s.Scan() {
		return piHeader{}, ErrUnavailable
	}
	var h piHeader
	if json.Unmarshal(s.Bytes(), &h) != nil || h.Type != "session" || (h.Version != 2 && h.Version != 3) || !sessionID.MatchString(h.ID) {
		return piHeader{}, ErrUnavailable
	}
	return h, nil
}

func (r *Reader) loadPiSession(ref Ref, refresh bool) (*piSession, error) {
	path, err := r.findPiTranscript(ref, refresh)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(filepath.Join(r.PiRoot, "sessions"))
	if err != nil {
		return nil, ErrUnavailable
	}
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return nil, ErrUnavailable
	}
	file, err := openPiRegular(root, relative)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxScanBytes {
		return nil, ErrUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(file, maxScanBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxScanBytes {
		return nil, ErrUnavailable
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(info, after) || info.Size() != after.Size() || info.ModTime() != after.ModTime() || int64(len(data)) != after.Size() {
		return nil, ErrUnavailable
	}
	// A writer may be between bytes. Only newline-committed records participate.
	if cut := bytes.LastIndexByte(data, '\n'); cut >= 0 {
		data = data[:cut+1]
	} else {
		return nil, ErrUnavailable
	}
	digest := sha256.Sum256(data)
	r.piMu.Lock()
	for i := range r.piCache {
		entry := &r.piCache[i]
		if entry.path == path && os.SameFile(entry.info, info) && entry.info.Size() == info.Size() && entry.info.ModTime() == info.ModTime() && entry.digest == digest && entry.session != nil && (ref.Kind != "id" || entry.sessionID == ref.Value) {
			r.piCacheTick++
			entry.tick = r.piCacheTick
			session := entry.session
			r.piMu.Unlock()
			return session, nil
		}
	}
	r.piMu.Unlock()
	session, err := parsePiSession(path, data, ref)
	if err != nil {
		return nil, err
	}
	r.piMu.Lock()
	for _, entry := range r.piCache {
		if entry.path == path && os.SameFile(entry.info, info) && entry.sessionID == session.id && len(data) >= entry.sourceBytes && sha256.Sum256(data[:entry.sourceBytes]) == entry.digest {
			session.incarnation = entry.incarnation
			break
		}
	}
	if session.incarnation == "" {
		session.incarnation = newPiIncarnation()
	}
	defer r.piMu.Unlock()
	r.piCacheTick++
	kept := make([]piCacheEntry, 0, min(len(r.piCache), 32))
	charge := piCacheCharge(len(data), len(session.entries))
	total := charge
	for _, entry := range r.piCache {
		if entry.path != path {
			kept = append(kept, entry)
			total += entry.bytes
		}
	}
	r.piCache = kept
	for len(r.piCache) >= 32 || (total > maxPiCacheBytes && len(r.piCache) > 0) {
		oldest := 0
		for i := range r.piCache {
			if r.piCache[i].tick < r.piCache[oldest].tick {
				oldest = i
			}
		}
		total -= r.piCache[oldest].bytes
		r.piCache = removePiCacheEntry(r.piCache, oldest)
	}
	if charge <= maxPiCacheBytes {
		r.piCache = append(r.piCache, piCacheEntry{path: path, info: info, digest: digest, bytes: charge, sourceBytes: len(data), tick: r.piCacheTick, session: session, sessionID: session.id, incarnation: session.incarnation})
	} else {
		// Keep only bounded identity so uncached trees retain cursor/detail
		// continuity across append without retaining parsed allocations.
		const identityCharge = 512
		r.piCache = append(r.piCache, piCacheEntry{path: path, info: info, digest: digest, bytes: identityCharge, sourceBytes: len(data), tick: r.piCacheTick, sessionID: session.id, incarnation: session.incarnation})
	}
	return session, nil
}

func removePiCacheEntry(entries []piCacheEntry, index int) []piCacheEntry {
	copy(entries[index:], entries[index+1:])
	entries[len(entries)-1] = piCacheEntry{}
	return entries[:len(entries)-1]
}

func piCacheCharge(sourceBytes, entries int) int {
	if entries > (maxPiCacheBytes-sourceBytes)/piCacheEntryOverhead {
		return maxPiCacheBytes + 1
	}
	// The second sourceBytes covers RawMessage/string payload copies retained by
	// encoding/json; the per-entry charge covers the structural containers.
	charge := sourceBytes*2 + entries*piCacheEntryOverhead
	if charge < sourceBytes {
		return maxPiCacheBytes + 1
	}
	return charge
}

func newPiIncarnation() string {
	var value [12]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "unavailable"
	}
	return base64.RawURLEncoding.EncodeToString(value[:])
}

func parsePiSession(path string, data []byte, ref Ref) (*piSession, error) {
	lines := bytes.Split(bytes.TrimSuffix(data, []byte{'\n'}), []byte{'\n'})
	if len(lines) == 0 || len(lines) > maxWalkEntries+1 {
		return nil, ErrUnavailable
	}
	var header piHeader
	if json.Unmarshal(lines[0], &header) != nil || header.Type != "session" || (header.Version != 2 && header.Version != 3) || !sessionID.MatchString(header.ID) {
		return nil, ErrUnavailable
	}
	if ref.Kind == "id" && header.ID != ref.Value {
		return nil, ErrUnavailable
	}
	s := &piSession{id: header.ID, path: path, entries: map[string]piEntry{}, branchSet: map[string]bool{}}
	for _, line := range lines[1:] {
		var entry piEntry
		if len(line) > maxTranscriptLine || json.Unmarshal(line, &entry) != nil || entry.ID == "" {
			return nil, ErrUnavailable
		}
		if !sessionID.MatchString(entry.ID) {
			return nil, ErrUnavailable
		}
		if _, exists := s.entries[entry.ID]; exists {
			return nil, ErrUnavailable
		}
		if entry.ParentID != nil {
			if _, exists := s.entries[*entry.ParentID]; !exists {
				return nil, ErrUnavailable
			}
		}
		if entry.Type == "message" {
			var message piMessage
			if len(entry.Message) == 0 || json.Unmarshal(entry.Message, &message) != nil || message.Role == "" {
				return nil, ErrUnavailable
			}
		}
		s.entries[entry.ID] = entry
		s.order = append(s.order, entry.ID)
	}
	if len(s.order) == 0 {
		return s, nil
	}
	seen := map[string]bool{}
	id := s.order[len(s.order)-1]
	for id != "" {
		if seen[id] {
			return nil, ErrUnavailable
		}
		seen[id] = true
		entry, ok := s.entries[id]
		if !ok {
			return nil, ErrUnavailable
		}
		s.branch = append(s.branch, entry)
		s.branchSet[id] = true
		if entry.ParentID == nil {
			break
		}
		id = *entry.ParentID
	}
	for i, j := 0, len(s.branch)-1; i < j; i, j = i+1, j-1 {
		s.branch[i], s.branch[j] = s.branch[j], s.branch[i]
	}
	return s, nil
}

func piText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []piBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func piEvents(session *piSession) []parsedEvent {
	var out []parsedEvent
	tools := map[string]int{}
	for ordinal, entry := range session.branch {
		eventOrdinal := 0
		add := func(event parsedEvent) {
			event.lineStart = ordinal
			event.sourceOrdinal = eventOrdinal
			event.At = recordTime(entry.Timestamp)
			eventOrdinal++
			out = append(out, event)
		}
		switch entry.Type {
		case "compaction":
			add(parsedEvent{Event: Event{Type: EventCompaction}})
		case "custom_message":
			if text := piText(entry.Content); entry.Display && text != "" {
				add(parsedEvent{Event: Event{Type: "assistant", Text: "[Extension] " + text}})
			}
		case "message":
			var msg piMessage
			if json.Unmarshal(entry.Message, &msg) != nil {
				continue
			}
			switch msg.Role {
			case "user":
				if text := piText(msg.Content); text != "" {
					add(parsedEvent{Event: Event{Type: "user", Text: text}})
				}
			case "assistant":
				var blocks []piBlock
				if json.Unmarshal(msg.Content, &blocks) != nil {
					continue
				}
				for _, block := range blocks {
					switch block.Type {
					case "text":
						if block.Text != "" {
							add(parsedEvent{Event: Event{Type: "assistant", Text: block.Text}})
						}
					case "thinking":
						if block.Thinking != "" {
							add(parsedEvent{Event: Event{Type: "thinking", Text: block.Thinking}})
						}
					case "toolCall":
						if toolName.MatchString(block.Name) && block.ID != "" {
							add(parsedEvent{Event: Event{Type: "tool", Name: block.Name, Input: compactJSON(block.Arguments)}, call: block.ID})
							tools[block.ID] = len(out) - 1
						}
					}
				}
				if msg.StopReason == "aborted" {
					add(parsedEvent{Event: Event{Type: EventInterrupt}})
				}
			case "toolResult":
				if index, ok := tools[msg.ToolCallID]; ok {
					out[index].Output = piText(msg.Content)
					if msg.IsError {
						out[index].State = "error"
					} else {
						out[index].State = "done"
					}
				}
			}
		}
	}
	return out
}

type piCursor struct {
	Version     int    `json:"v"`
	Ref         string `json:"r"`
	Session     string `json:"s"`
	Incarnation string `json:"i"`
	Entry       string `json:"e"`
	Ordinal     int    `json:"o"`
}

func encodePiCursor(ref Ref, session *piSession, entry string, ordinal int) string {
	raw, _ := json.Marshal(piCursor{Version: 1, Ref: refFingerprint(ref), Session: session.id, Incarnation: session.incarnation, Entry: entry, Ordinal: ordinal})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func decodePiCursor(ref Ref, session *piSession, raw *string) (*piCursor, error) {
	if raw == nil {
		return nil, nil
	}
	if len(*raw) > 1024 {
		return nil, ErrCursorInvalid
	}
	data, err := base64.RawURLEncoding.DecodeString(*raw)
	if err != nil {
		return nil, ErrCursorInvalid
	}
	var cursor piCursor
	if json.Unmarshal(data, &cursor) != nil || cursor.Version != 1 || cursor.Ref != refFingerprint(ref) || cursor.Session != session.id || cursor.Incarnation != session.incarnation || cursor.Entry == "" || cursor.Ordinal < 0 || cursor.Ordinal > 1024 {
		return nil, ErrCursorConflict
	}
	if !session.branchSet[cursor.Entry] {
		return nil, ErrCursorConflict
	}
	return &cursor, nil
}

func (r *Reader) readPiHistory(ref Ref, cursor *string, limit int) (Page, error) {
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 200 {
		return Page{}, errors.New("invalid history limit")
	}
	s, err := r.loadPiSession(ref, true)
	if err != nil {
		return Page{}, err
	}
	decoded, err := decodePiCursor(ref, s, cursor)
	if err != nil {
		return Page{}, err
	}
	type indexedMessage struct {
		message     Message
		branchIndex int
	}
	var all []indexedMessage
	for branchIndex, entry := range s.branch {
		if entry.Type == "custom_message" && entry.Display {
			if text := piText(entry.Content); text != "" {
				all = append(all, indexedMessage{Message{Role: "assistant", Text: "[Extension] " + text}, branchIndex})
			}
			continue
		}
		if entry.Type != "message" {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil {
			continue
		}
		if msg.Role == "user" || msg.Role == "assistant" {
			if text := piText(msg.Content); text != "" {
				all = append(all, indexedMessage{Message{Role: msg.Role, Text: text}, branchIndex})
			}
		}
	}
	end := len(all)
	if decoded != nil {
		end = -1
		for i, item := range all {
			if s.branch[item.branchIndex].ID == decoded.Entry && decoded.Ordinal == 0 {
				end = i
				break
			}
		}
		if end < 0 {
			return Page{}, ErrCursorConflict
		}
	}
	all = all[:end]
	start := len(all)
	pageBytes := 0
	hadClipping := false
	for start > 0 && len(all)-start < limit {
		candidate := all[start-1].message
		var clipped bool
		candidate.Text, clipped = clip(candidate.Text, maxMessageBytes, false)
		hadClipping = hadClipping || clipped
		encoded, _ := json.Marshal(candidate)
		if pageBytes+len(encoded) > maxPageItemsBytes {
			break
		}
		all[start-1].message = candidate
		pageBytes += len(encoded)
		start--
	}
	page := Page{Messages: make([]Message, 0, len(all)-start), Truncated: hadClipping || (start > 0 && pageBytes == 0)}
	for _, item := range all[start:] {
		page.Messages = append(page.Messages, item.message)
	}
	if start > 0 {
		next := encodePiCursor(ref, s, s.branch[all[start].branchIndex].ID, 0)
		page.NextCursor = &next
	}
	return page, nil
}

func (r *Reader) readPiTrace(ref Ref, cursor *string, limit int, options TraceOptions) (TracePage, error) {
	s, err := r.loadPiSession(ref, true)
	if err != nil {
		return TracePage{}, err
	}
	decoded, err := decodePiCursor(ref, s, cursor)
	if err != nil {
		return TracePage{}, err
	}
	var events []parsedEvent
	for _, event := range piEvents(s) {
		if event, keep := options.adapt(event); keep {
			events = append(events, event)
		}
	}
	end := len(events)
	if decoded != nil {
		end = -1
		for i, event := range events {
			if s.branch[event.lineStart].ID == decoded.Entry && event.sourceOrdinal == decoded.Ordinal {
				end = i
				break
			}
		}
		if end < 0 {
			return TracePage{}, ErrCursorConflict
		}
	}
	events = events[:end]
	start := len(events)
	pageBytes := 0
	for start > 0 && len(events)-start < limit {
		candidate, _ := clipEvent(events[start-1].Event, false)
		size := eventSize(candidate)
		if pageBytes+size > maxTraceItemsBytes {
			break
		}
		events[start-1].Event = candidate
		pageBytes += size
		start--
	}
	page := TracePage{Truncated: start > 0 && pageBytes == 0}
	emittedBytes := 0
	for _, parsed := range events[start:] {
		ev, clipped := clipEvent(parsed.Event, false)
		ev, clipped = clipEventToLimit(ev, maxTraceItemsBytes-emittedBytes, clipped)
		if eventSize(ev) > maxTraceItemsBytes-emittedBytes {
			return TracePage{}, ErrUnavailable
		}
		emittedBytes += eventSize(ev)
		page.Truncated = page.Truncated || clipped
		if ev.Type != "tool" {
			page.SummaryTruncated = page.SummaryTruncated || clipped
		}
		if ev.Type == "tool" {
			ev.DetailRef = encodePiDetail(ref, s, s.branch[parsed.lineStart].ID, parsed.sourceOrdinal, parsed.call, parsed.Name, piToolStatic(parsed), traceDetailRevision(parsed.Event))
		}
		page.Items = append(page.Items, ev)
	}
	if start > 0 {
		next := encodePiCursor(ref, s, s.branch[events[start].lineStart].ID, events[start].sourceOrdinal)
		page.NextCursor = &next
	}
	return page, nil
}

func piToolStatic(event parsedEvent) string {
	sum := sha256.Sum256([]byte(event.call + "\x00" + event.Name + "\x00" + event.Input))
	return base64.RawURLEncoding.EncodeToString(sum[:12])
}

type piDetailLocator struct {
	Version     int    `json:"v"`
	Ref         string `json:"r"`
	Session     string `json:"s"`
	Incarnation string `json:"i"`
	Entry       string `json:"e"`
	Ordinal     int    `json:"o"`
	Call        string `json:"c"`
	Name        string `json:"n"`
	Static      string `json:"h"`
	Revision    string `json:"x"`
}

func encodePiDetail(ref Ref, session *piSession, entry string, ordinal int, call, name, static, revision string) string {
	raw, _ := json.Marshal(piDetailLocator{Version: 1, Ref: refFingerprint(ref), Session: session.id, Incarnation: session.incarnation, Entry: entry, Ordinal: ordinal, Call: call, Name: name, Static: static, Revision: revision})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func (r *Reader) readPiTraceDetail(ref Ref, detail string) (TraceDetail, error) {
	if detail == "" || len(detail) > 2048 {
		return TraceDetail{}, ErrCursorInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(detail)
	if err != nil {
		return TraceDetail{}, ErrCursorInvalid
	}
	var locator piDetailLocator
	if json.Unmarshal(raw, &locator) != nil || locator.Version != 1 || locator.Ref != refFingerprint(ref) || locator.Entry == "" || locator.Ordinal < 0 || locator.Ordinal > 1024 {
		return TraceDetail{}, ErrCursorConflict
	}
	s, err := r.loadPiSession(ref, true)
	if err != nil {
		return TraceDetail{}, err
	}
	if locator.Session != s.id || locator.Incarnation != s.incarnation || !s.branchSet[locator.Entry] {
		return TraceDetail{}, ErrCursorConflict
	}
	for _, ev := range piEvents(s) {
		if ev.call == locator.Call && ev.Name == locator.Name && ev.sourceOrdinal == locator.Ordinal && piToolStatic(ev) == locator.Static && s.branch[ev.lineStart].ID == locator.Entry {
			item, truncated := clipEvent(ev.Event, false)
			return TraceDetail{DetailRef: detail, Text: item.Text, Input: item.Input, Output: item.Output, Truncated: truncated}, nil
		}
	}
	return TraceDetail{}, ErrCursorConflict
}
