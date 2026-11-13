package journal

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"io"
	"strconv"
	"sync"
)

// Revalidate every byte in the bounded tail, including rewrites before the
// append boundary. Only parsing is incremental; offsets and exact record hashes
// decide reuse. Retain at most 1024 classifications per cached transcript.
const maxActivityRecords = 1024

type activityRecord struct {
	offset                       int64
	digest                       [32]byte
	invalid, evidence, submitted bool
	key, state                   string
}

type activityFlight struct {
	mu    sync.Mutex
	users int
}

func (r *Reader) lockActivity(key string) func() {
	r.activityMu.Lock()
	if r.activityFlights == nil {
		r.activityFlights = make(map[string]*activityFlight)
	}
	f := r.activityFlights[key]
	if f == nil {
		f = &activityFlight{}
		r.activityFlights[key] = f
	}
	f.users++
	r.activityMu.Unlock()
	f.mu.Lock()
	return func() {
		f.mu.Unlock()
		r.activityMu.Lock()
		f.users--
		if f.users == 0 {
			delete(r.activityFlights, key)
		}
		r.activityMu.Unlock()
	}
}

func readActivityWindow(reader io.ReaderAt, size int64, agent string, previous []activityRecord) (Activity, []activityRecord, error) {
	start := max(int64(0), size-activityReadBytes)
	data := make([]byte, size-start)
	if _, err := reader.ReadAt(data, start); err != nil && err != io.EOF {
		return Activity{}, nil, err
	}
	activity, records, _ := scanActivityWindow(agent, data, start, previous)
	return activity, records, nil
}

// parsedBytes is a measurement seam, not runtime telemetry.
func scanActivityWindow(agent string, data []byte, offset int64, previous []activityRecord) (activity Activity, records []activityRecord, parsedBytes int) {
	activity.Known = offset == 0
	if offset > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			return Activity{}, nil, 0
		}
		offset += int64(end + 1)
		data = data[end+1:]
	}
	old := 0
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			activity.Known = activity.Key != ""
			break
		}
		line := data[:end]
		digest := sha256.Sum256(line)
		for old < len(previous) && previous[old].offset < offset {
			old++
		}
		var record activityRecord
		if old < len(previous) && previous[old].offset == offset && previous[old].digest == digest {
			record = previous[old]
		} else {
			parsedBytes += len(line)
			record = activityRecord{offset: offset, digest: digest}
			record.invalid = !json.Valid(line) && len(bytes.TrimSpace(line)) > 0
			if !record.invalid {
				record.evidence, record.submitted = classifyActivityLine(agent, line)
				if record.evidence {
					record.key = activityKey(strconv.FormatInt(offset, 10), line)
					if agent == "codex" {
						record.state = codexActivityState(line)
					}
				}
			}
		}
		if record.invalid {
			activity.Known = false
		} else {
			activity.Submitted = activity.Submitted || record.submitted
			if record.evidence {
				activity.Known = true
				activity.Key = record.key
				if record.state != "" {
					activity.State = record.state
				}
			}
		}
		// Keep the most recent records, with a bounded backing allocation.
		if len(records) == maxActivityRecords {
			copy(records, records[maxActivityRecords/2:])
			records = records[:maxActivityRecords/2]
		}
		records = append(records, record)
		offset += int64(end + 1)
		data = data[end+1:]
	}
	return
}
