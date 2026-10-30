package journal

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
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
	Name       string          `json:"name"`
	Timestamp  json.RawMessage `json:"timestamp"`
}

type piHeader struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	ID      string `json:"id"`
}

type piMessage struct {
	Role          string          `json:"role"`
	Content       json.RawMessage `json:"content"`
	Command       string          `json:"command"`
	ToolCallID    string          `json:"toolCallId"`
	ToolName      string          `json:"toolName"`
	IsError       bool            `json:"isError"`
	StopReason    string          `json:"stopReason"`
	ErrorMessage  string          `json:"errorMessage"`
	Model         string          `json:"model"`
	ThinkingLevel string          `json:"thinkingLevel"`
}

type piBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// piAgent reports whether an agent's transcripts use the Pi session tree.
// Prime Agent is a Pi fork: same header, entry tree and tool records.
func piAgent(agent string) bool { return agent == "pi" || agent == "prime-agent" }

// piSessionsDir is the directory holding one agent's Pi-format sessions.
// Empty means the adapter is not configured.
func (r *Reader) piSessionsDir(agent string) string {
	switch agent {
	case "pi":
		if r.PiRoot == "" {
			return ""
		}
		return filepath.Join(r.PiRoot, "sessions")
	case "prime-agent":
		if r.PrimeSessionDir != "" {
			return r.PrimeSessionDir
		}
		if r.PrimeRoot == "" {
			return ""
		}
		return filepath.Join(r.PrimeRoot, "sessions")
	default:
		return ""
	}
}

func piPathSyntax(sessions, value string) bool {
	if !filepath.IsAbs(value) || filepath.Clean(value) != value || filepath.Ext(value) != ".jsonl" {
		return false
	}
	for _, part := range strings.Split(filepath.ToSlash(value), "/") {
		if part == ".." {
			return false
		}
	}
	absRoot, err := filepath.Abs(sessions)
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
	sessions := r.piSessionsDir(ref.Agent)
	if sessions == "" {
		return "", ErrUnavailable
	}
	root, err := filepath.Abs(sessions)
	if err != nil {
		return "", ErrUnavailable
	}
	if ref.Kind == "path" {
		if !piPathSyntax(root, ref.Value) {
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
	sessions := r.piSessionsDir(ref.Agent)
	if sessions == "" {
		return nil, ErrUnavailable
	}
	root, err := filepath.Abs(sessions)
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
