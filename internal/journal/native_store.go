package journal

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
)

func nativeStoreAgent(agent string) bool {
	switch agent {
	case "cmd", "gemini", "qwen", "cline", "amp", "droid", "maki", "muse", "agy", "letta", "qodercli", "kiro", "devin", "kimi":
		return true
	}
	return false
}

// Native stores can rewrite history. Render a bounded, consistent snapshot;
// never interpret their append-only edit records as ordinary chat messages.
func (r *Reader) loadNativeStore(ref Ref, entry *storeEntry) ([]storeRecord, string, bool, error) {
	path, err := r.nativeTranscriptPath(ref)
	if err != nil {
		return nil, "", false, err
	}
	base := r.NativeRoots[ref.Agent]
	if ref.Agent == "kimi" {
		base = r.kimiTranscriptBase(path)
	}
	file, err := openActivityFile(base, path)
	if err != nil {
		return nil, "", false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > maxScanBytes {
		return nil, "", false, ErrUnavailable
	}
	stamp := path + ":" + strconv.FormatInt(info.Size(), 10) + ":" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	if ref.Agent == "cmd" {
		stamp += ":" + fileStamp(commandCodeMetaPath(path))
	}
	if ref.Agent == "kiro" {
		stamp += ":" + fileStamp(filepath.Join(filepath.Dir(path), "session.json"))
	}
	if ref.Agent == "kimi" {
		if state, err := os.Stat(kimiStatePath(path)); err == nil {
			stamp += ":" + strconv.FormatInt(state.ModTime().UnixNano(), 10) + ":" + strconv.FormatInt(state.Size(), 10)
		}
	}
	if entry.snapshot != nil && entry.err == nil && stamp == entry.stamp {
		return nil, stamp, true, nil
	}
	data, err := io.ReadAll(io.LimitReader(file, maxScanBytes+1))
	after, statErr := file.Stat()
	if err != nil || statErr != nil || len(data) > maxScanBytes || after.Size() != info.Size() || after.ModTime() != info.ModTime() {
		return nil, "", false, ErrUnavailable
	}
	var records []storeRecord
	var title Title
	switch ref.Agent {
	case "cmd":
		records, title, err = r.parseCommandCodeSession(data, ref, path)
	case "muse":
		records, title, err = parseMuseSession(data, ref.Value)
	case "agy":
		records, title, err = parseAgySession(data)
	case "letta":
		records, title, err = parseLettaSession(data)
	case "qodercli":
		records, title, err = parseQoderSession(data, ref.Value)
	case "kiro":
		records, title, err = r.parseKiroSession(data, ref, path)
	case "amp":
		records, title, err = parseAmpSession(data, ref.Value)
	case "droid":
		records, title, err = parseDroidSession(data, ref.Value)
	case "maki":
		records, title, err = parseMakiSession(data, ref.Value)
	case "kimi":
		records, title, err = r.parseKimiSession(data, ref, path, base)
	case "cline":
		records, title, err = parseClineSession(data, ref.Value)
	case "gemini":
		records, title, err = parseGeminiSession(data, ref.Value, filepath.Ext(path) == ".jsonl")
	case "qwen":
		records, title, err = parseQwenSession(data, ref.Value)
	default:
		err = ErrUnavailable
	}
	if err == nil {
		entry.title = title
	}
	return records, stamp, false, err
}

func (r *Reader) nativeStoreTitle(ref Ref) (Title, bool) {
	if _, err := r.loadStore(ref, false); err != nil {
		return Title{}, false
	}
	r.storeMu.Lock()
	defer r.storeMu.Unlock()
	entry := r.storeCache[storeBindingKey(ref)]
	if entry == nil || entry.err != nil {
		return Title{}, false
	}
	return entry.title, true
}

// Ignore an incomplete final append; malformed complete records fail closed.
func nativeLines(data []byte, visit func([]byte) error) error {
	if end := bytes.LastIndexByte(data, '\n'); end >= 0 {
		data = data[:end+1]
	} else {
		return ErrUnavailable
	}
	var parseErr error
	err := forEachLine(bytes.NewReader(data), maxTraceLine, func(line []byte, _ int, oversized bool) bool {
		if oversized {
			parseErr = ErrUnavailable
			return false
		}
		if len(bytes.TrimSpace(line)) == 0 {
			return true
		}
		if !json.Valid(line) {
			parseErr = ErrUnavailable
			return false
		}
		parseErr = visit(line)
		return parseErr == nil
	})
	if err != nil {
		return err
	}
	return parseErr
}
