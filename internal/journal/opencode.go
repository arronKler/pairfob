package journal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// opencode before 1.2 keeps a session as files under <root>/storage:
//
//	session/<project>/<session>.json
//	message/<session>/<message>.json
//	part/<message>/<part>.json
//
// Message and part ids sort in the order they were made. opencode 1.2 and
// later keep sessions in a SQLite database instead, which this reader does not
// open: such a session is unavailable.

const (
	// A session shows its newest messages within these bounds.
	maxOpencodeMessages = 2000
	maxOpencodeParts    = 20_000
	maxOpencodeFile     = 8 << 20
)

var (
	opencodeMessageFile = regexp.MustCompile(`^msg_[0-9A-Za-z]{1,64}\.json$`)
	opencodePartFile    = regexp.MustCompile(`^prt_[0-9A-Za-z]{1,64}\.json$`)
)

// opencodeState keeps each file's rendered records until the file changes.
type opencodeState struct {
	files map[string]opencodeFile
}

type opencodeFile struct {
	size     int64
	modified int64
	message  opencodeMessage
	records  []storeRecord
}

type opencodeMessage struct {
	Role string `json:"role"`
	Time struct {
		Created int64 `json:"created"`
	} `json:"time"`
	// Summary is true on the assistant message that replaces compacted
	// context; a user message carries an unrelated object here.
	Summary json.RawMessage `json:"summary"`
	Error   struct {
		Name string `json:"name"`
	} `json:"error"`
}

type opencodePart struct {
	Type      string `json:"type"`
	Text      string `json:"text"`
	Synthetic bool   `json:"synthetic"`
	Ignored   bool   `json:"ignored"`
	Tool      string `json:"tool"`
	CallID    string `json:"callID"`
	Time      struct {
		Start int64 `json:"start"`
	} `json:"time"`
	State struct {
		Status   string          `json:"status"`
		Input    json.RawMessage `json:"input"`
		Output   string          `json:"output"`
		Error    string          `json:"error"`
		Metadata struct {
			Exit json.RawMessage `json:"exit"`
		} `json:"metadata"`
		Time struct {
			Start int64 `json:"start"`
		} `json:"time"`
	} `json:"state"`
}

type opencodeEntry struct {
	path     string
	size     int64
	modified int64
}

// loadOpencode lists the session's files and renders the ones that changed.
// With the stamp entry already holds, nothing is read and records is nil.
func (r *Reader) loadOpencode(id string, entry *storeEntry) (records []storeRecord, stamp string, err error) {
	if r.OpencodeRoot == "" || !sessionID.MatchString(id) {
		return nil, "", ErrUnavailable
	}
	// Every read below stays inside the storage directory, whatever a path in
	// it links to.
	root, err := os.OpenRoot(filepath.Join(r.OpencodeRoot, "storage"))
	if err != nil {
		return nil, "", ErrUnavailable
	}
	defer root.Close()
	store := root.FS()
	if sessions, err := fs.Glob(store, "session/*/"+id+".json"); err != nil || len(sessions) != 1 {
		return nil, "", ErrUnavailable
	}
	messages := opencodeEntries(store, "message/"+id, opencodeMessageFile)
	if len(messages) > maxOpencodeMessages {
		messages = messages[len(messages)-maxOpencodeMessages:]
	}
	parts := make(map[string][]opencodeEntry, len(messages))
	total := 0
	hash := sha256.New()
	for _, message := range messages {
		name := strings.TrimSuffix(filepath.Base(message.path), ".json")
		list := opencodeEntries(store, "part/"+name, opencodePartFile)
		if total += len(list); total > maxOpencodeParts {
			return nil, "", ErrUnavailable
		}
		parts[message.path] = list
		for _, file := range append([]opencodeEntry{message}, list...) {
			hash.Write([]byte(file.path + "\x00" + strconv.FormatInt(file.size, 10) + "\x00" + strconv.FormatInt(file.modified, 10) + "\n"))
		}
	}
	stamp = hex.EncodeToString(hash.Sum(nil))
	if entry.opencode != nil && entry.stamp == stamp {
		return nil, stamp, nil
	}
	previous := entry.opencode
	next := &opencodeState{files: make(map[string]opencodeFile, len(messages)+total)}
	cached := func(file opencodeEntry) (opencodeFile, bool) {
		if previous == nil {
			return opencodeFile{}, false
		}
		old, ok := previous.files[file.path]
		return old, ok && old.size == file.size && old.modified == file.modified
	}
	for _, message := range messages {
		meta, ok := cached(message)
		if !ok {
			meta = opencodeFile{size: message.size, modified: message.modified}
			if json.Unmarshal(readOpencodeFile(root, message), &meta.message) != nil {
				// Being written, or not a message: it shows once it parses.
				continue
			}
		}
		next.files[message.path] = meta
		at := meta.message.Time.Created
		if meta.message.Role == "assistant" && string(meta.message.Summary) == "true" {
			records = append(records, storeRecord{Kind: storeCompaction, At: at})
			continue
		}
		var typed []string
		for _, file := range parts[message.path] {
			part, ok := cached(file)
			if !ok {
				part = opencodeFile{size: file.size, modified: file.modified}
				var decoded opencodePart
				if json.Unmarshal(readOpencodeFile(root, file), &decoded) == nil {
					part.records = opencodePartRecords(meta.message.Role, decoded, at)
				}
			}
			next.files[file.path] = part
			for _, record := range part.records {
				if record.Kind == storeUser {
					typed = append(typed, record.Text)
					continue
				}
				records = append(records, record)
			}
		}
		if len(typed) > 0 {
			// One prompt, however many text parts it was stored as.
			records = append(records, storeRecord{Kind: storeUser, Text: strings.Join(typed, "\n\n"), At: at})
		}
		if meta.message.Role == "assistant" && meta.message.Error.Name == "MessageAbortedError" {
			records = append(records, storeRecord{Kind: storeInterrupt, At: at})
		}
	}
	entry.opencode = next
	return records, stamp, nil
}

// opencodeEntries lists a directory's regular files whose names match, in id
// order. A missing directory is an empty one: a new session has no messages.
func opencodeEntries(store fs.FS, dir string, name *regexp.Regexp) []opencodeEntry {
	listed, err := fs.ReadDir(store, dir)
	if err != nil {
		return nil
	}
	out := make([]opencodeEntry, 0, len(listed))
	for _, item := range listed {
		if !name.MatchString(item.Name()) {
			continue
		}
		info, err := item.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxOpencodeFile {
			continue
		}
		out = append(out, opencodeEntry{path: dir + "/" + item.Name(), size: info.Size(), modified: info.ModTime().UnixNano()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].path < out[j].path })
	return out
}

func readOpencodeFile(root *os.Root, file opencodeEntry) []byte {
	handle, err := root.Open(file.path)
	if err != nil {
		return nil
	}
	defer handle.Close()
	data, err := io.ReadAll(io.LimitReader(handle, maxOpencodeFile+1))
	if err != nil || len(data) > maxOpencodeFile {
		return nil
	}
	return data
}

func opencodePartRecords(role string, part opencodePart, created int64) []storeRecord {
	at := created
	for _, start := range []int64{part.State.Time.Start, part.Time.Start} {
		if start > 0 {
			at = start
			break
		}
	}
	switch {
	case part.Type == "text" && part.Text != "" && !part.Synthetic && !part.Ignored:
		if role == "user" {
			if text := strings.TrimSpace(part.Text); text != "" {
				return []storeRecord{{Kind: storeUser, Text: text, At: at}}
			}
			return nil
		}
		return []storeRecord{{Kind: storeAssistant, Text: part.Text, At: at}}
	case role == "assistant" && part.Type == "reasoning" && strings.TrimSpace(part.Text) != "":
		return []storeRecord{{Kind: storeThinking, Text: part.Text, At: at}}
	case role == "assistant" && part.Type == "tool":
		record := storeRecord{Kind: storeTool, Name: part.Tool, Call: part.CallID, Input: compactJSON(part.State.Input), At: at}
		switch part.State.Status {
		case "completed":
			record.Output, record.State = part.State.Output, "done"
			// opencode reports a finished command as completed whatever it returned.
			if code, err := strconv.ParseFloat(string(part.State.Metadata.Exit), 64); err == nil && code != 0 {
				record.State = "error"
			}
		case "error":
			record.Output, record.State = part.State.Error, "error"
		}
		return []storeRecord{record}
	}
	return nil
}
