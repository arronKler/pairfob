package journal

import (
	"bytes"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"
)

// Hermes keeps its sessions in a SQLite database and opencode in a tree of
// small JSON files. Neither is an append-only log, so a session is rendered
// into the journal's own line format: one record per line, in session order,
// byte-stable for the part of the session that has not changed. The line
// readers then page it, cut detail from it and find activity in it exactly as
// they do in a log file, and offsets into it are valid cursors.

const (
	storeUser       = "user"
	storeAssistant  = "assistant"
	storeThinking   = "thinking"
	storeTool       = "tool"
	storeResult     = "result"
	storeCommand    = "command"
	storeInterrupt  = "interrupt"
	storeCompaction = "compaction"
)

const (
	// A field larger than a trace event can carry is cut when rendered, so one
	// line never approaches maxTraceLine.
	maxStoreField = 2 * maxTraceEventBytes
	// The rendered session keeps its newest records within this bound.
	maxStoreBytes = maxScanBytes
	// Snapshot polling reuses a rendered session for this long before it looks
	// at the store again. Reads the phone asks for always look.
	storePollTTL = 2 * time.Second
	// A store that could not be read is not asked again by polling for this
	// long, so a locked database cannot stall every snapshot.
	storeFailureTTL    = 10 * time.Second
	maxStoreCacheItems = 8
)

// storeRecord is one rendered line.
type storeRecord struct {
	Kind string `json:"k"`
	Text string `json:"text,omitempty"`
	Name string `json:"name,omitempty"`
	// Call pairs a result with its tool.
	Call   string `json:"call,omitempty"`
	Input  string `json:"input,omitempty"`
	Output string `json:"output,omitempty"`
	// State is done or error once the agent recorded how a tool ended.
	State string `json:"state,omitempty"`
	At    int64  `json:"at,omitempty"`
}

type storeSnapshot struct {
	data []byte
	// revision changes whenever data does.
	revision int64
}

type storeEntry struct {
	// stamp is the loader's cheap description of the store; an equal stamp
	// means the session cannot have changed.
	stamp    string
	loadedAt time.Time
	snapshot *storeSnapshot
	err      error
	used     uint64
	opencode *opencodeState
}

var storeRevision atomic.Int64

func storeAgent(agent string) bool {
	return agent == "hermes" || agent == "opencode"
}

// loadStore returns the session's rendered lines. refresh forces a look at the
// store; without it a recent rendering is reused, for snapshot polling.
func (r *Reader) loadStore(ref Ref, refresh bool) (*storeSnapshot, error) {
	now := time.Now()
	if r.now != nil {
		now = r.now()
	}
	key := ref.Agent + "\x00" + ref.Value
	// One load at a time: the monitor and a phone read share the work.
	r.storeMu.Lock()
	defer r.storeMu.Unlock()
	r.storeTick++
	entry := r.storeCache[key]
	if entry != nil {
		entry.used = r.storeTick
		if age := now.Sub(entry.loadedAt); !refresh && (age < storePollTTL || (entry.err != nil && age < storeFailureTTL)) {
			return entry.snapshot, entry.err
		}
	} else {
		entry = &storeEntry{used: r.storeTick}
	}
	var (
		records []storeRecord
		stamp   string
		same    bool
		err     error
	)
	switch ref.Agent {
	case "hermes":
		stamp, err = r.hermesStamp()
		if same = err == nil && stamp == entry.stamp && entry.loadedAt != (time.Time{}); !same && err == nil {
			records, err = r.loadHermes(ref.Value)
		}
	case "opencode":
		previous := entry.opencode
		records, stamp, err = r.loadOpencode(ref.Value, entry)
		same = err == nil && previous != nil && stamp == entry.stamp
	default:
		err = ErrUnavailable
	}
	entry.loadedAt = now
	if same {
		return entry.snapshot, entry.err
	}
	entry.stamp = stamp
	if err != nil {
		if !errors.Is(err, ErrUnavailable) {
			// A store that cannot be read is unavailable, never an empty chat.
			err = ErrUnavailable
		}
		entry.snapshot, entry.err = nil, err
	} else {
		data := renderStore(records)
		if entry.snapshot == nil || entry.err != nil || !bytes.Equal(entry.snapshot.data, data) {
			entry.snapshot = &storeSnapshot{data: data, revision: storeRevision.Add(1)}
		}
		entry.err = nil
	}
	if r.storeCache == nil {
		r.storeCache = make(map[string]*storeEntry)
	}
	r.storeCache[key] = entry
	for len(r.storeCache) > maxStoreCacheItems {
		oldest := ""
		for name, candidate := range r.storeCache {
			if oldest == "" || candidate.used < r.storeCache[oldest].used {
				oldest = name
			}
		}
		delete(r.storeCache, oldest)
	}
	return entry.snapshot, entry.err
}

// renderStore writes one line per record. When a session outgrows the bound,
// whole records are dropped from its start.
func renderStore(records []storeRecord) []byte {
	lines := make([][]byte, 0, len(records))
	total := 0
	for _, record := range records {
		record.Text, _ = clip(record.Text, maxStoreField, false)
		record.Input, _ = clip(record.Input, maxStoreField, false)
		record.Output, _ = clipHeadTail(record.Output, maxStoreField, false)
		line, err := json.Marshal(record)
		if err != nil {
			continue
		}
		lines = append(lines, line)
		total += len(line) + 1
	}
	first := 0
	for total > maxStoreBytes && first < len(lines) {
		total -= len(lines[first]) + 1
		first++
	}
	data := make([]byte, 0, total)
	for _, line := range lines[first:] {
		data = append(data, line...)
		data = append(data, '\n')
	}
	return data
}

func parseStoreTrace(line []byte) []parsedEvent {
	var record storeRecord
	if json.Unmarshal(line, &record) != nil {
		return nil
	}
	event := parsedEvent{Event: Event{At: record.At}, call: record.Call}
	switch record.Kind {
	case storeUser, storeAssistant, storeThinking:
		if record.Text == "" {
			return nil
		}
		event.Type, event.Text = record.Kind, record.Text
	case storeCommand:
		if record.Text == "" {
			return nil
		}
		event.Type, event.Text = EventCommand, record.Text
	case storeInterrupt:
		event.Type = EventInterrupt
	case storeCompaction:
		event.Type = EventCompaction
	case storeTool:
		if !toolName.MatchString(record.Name) {
			return nil
		}
		event.Type, event.Name, event.Input = "tool", record.Name, record.Input
		event.Output, event.State = record.Output, storeState(record.State)
	case storeResult:
		event.Type, event.outputOnly = "tool", true
		event.Output, event.State = record.Output, storeState(record.State)
		if event.Output == "" {
			// An output-only record attaches by its text; a tool that ended
			// with none still ended.
			event.Output = "完成"
			if event.State == "error" {
				event.Output = "失败"
			}
		}
	default:
		return nil
	}
	return []parsedEvent{event}
}

func storeState(state string) string {
	if state == "done" || state == "error" {
		return state
	}
	return ""
}

func parseStore(line []byte) (Message, bool) {
	var record storeRecord
	if json.Unmarshal(line, &record) != nil {
		return Message{}, false
	}
	switch record.Kind {
	case storeUser, storeCommand:
		if record.Text != "" {
			return Message{Role: "user", Text: record.Text}, true
		}
	case storeAssistant:
		if record.Text != "" {
			return Message{Role: "assistant", Text: record.Text}, true
		}
	case storeTool:
		if toolName.MatchString(record.Name) {
			return Message{Role: "assistant", Text: "工具 · " + record.Name}, true
		}
	}
	return Message{}, false
}

// storeActivity is ReadActivity for a rendered session. The rendering is
// already cached by loadStore, so the bounded tail is scanned each time.
func (r *Reader) storeActivity(ref Ref) Activity {
	snapshot, err := r.loadStore(ref, false)
	if err != nil {
		return Activity{}
	}
	start := max(0, len(snapshot.data)-activityReadBytes)
	return scanActivity(ref.Agent, snapshot.data[start:], int64(start))
}
