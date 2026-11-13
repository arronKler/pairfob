package journal

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Replays the last completed record of real local logs in memory. It never
// modifies a transcript or prints paths, identities, content or activity keys.
func TestLocalActivityProfile(t *testing.T) {
	if os.Getenv("PAIRFOB_PROFILE_LOCAL_ACTIVITY") != "1" {
		t.Skip("opt-in local activity profile")
	}
	r := NewDefault()
	files, _ := filepath.Glob(filepath.Join(r.ClaudeRoot, "projects", "*", "*.jsonl"))
	type sample struct {
		data  []byte
		start int64
		old   []activityRecord
	}
	type fileStamp struct {
		path string
		when time.Time
	}
	stamps := []fileStamp{}
	for _, path := range files {
		if info, err := os.Stat(path); err == nil {
			stamps = append(stamps, fileStamp{path, info.ModTime()})
		}
	}
	sort.Slice(stamps, func(i, j int) bool { return stamps[i].when.After(stamps[j].when) })
	samples := []sample{}
	bytesRead, parsed := 0, 0
	for _, entry := range stamps {
		if len(samples) == 20 {
			break
		}
		file, err := openActivityFile(r.ClaudeRoot, entry.path)
		if err != nil {
			continue
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			continue
		}
		start := max(int64(0), info.Size()-activityReadBytes)
		data := make([]byte, info.Size()-start)
		_, err = file.ReadAt(data, start)
		file.Close()
		if err != nil && err != io.EOF {
			continue
		}
		end := bytes.LastIndexByte(data, '\n')
		if end <= 0 {
			continue
		}
		data = data[:end+1]
		cut := bytes.LastIndexByte(data[:end], '\n') + 1
		if cut <= 0 {
			continue
		}
		_, old, _ := scanActivityWindow("claude", data[:cut], start, nil)
		got, _, n := scanActivityWindow("claude", data, start, old)
		if got != scanActivity("claude", data, start) {
			t.Fatal("incremental result differs from cold scan")
		}
		bytesRead += len(data)
		parsed += n
		samples = append(samples, sample{data, start, old})
	}
	if len(samples) == 0 {
		t.Skip("no readable complete local log windows")
	}
	for round := 0; round < 3; round++ {
		baseline := func() {
			for _, s := range samples {
				scanActivity("claude", s.data, s.start)
			}
		}
		candidate := func() {
			for _, s := range samples {
				scanActivityWindow("claude", s.data, s.start, s.old)
			}
		}
		measure := func(fn func()) time.Duration { start := time.Now(); fn(); return time.Since(start) }
		var before, after time.Duration
		if round%2 == 0 {
			before = measure(baseline)
			after = measure(candidate)
		} else {
			after = measure(candidate)
			before = measure(baseline)
		}
		t.Logf("round=%d windows=%d validated_bytes=%d parsed_candidate_bytes=%d baseline_ms=%.3f candidate_ms=%.3f", round, len(samples), bytesRead, parsed, float64(before)/float64(time.Millisecond), float64(after)/float64(time.Millisecond))
	}
}
