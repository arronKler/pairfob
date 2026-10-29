package journal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalTranscriptsCommandCode(t *testing.T) {
	if os.Getenv("PAIRFOB_SCAN_LOCAL_TRANSCRIPTS") != "1" {
		t.Skip("set PAIRFOB_SCAN_LOCAL_TRANSCRIPTS=1")
	}
	r := NewDefault()
	root := r.NativeRoots["cmd"]
	paths, _ := filepath.Glob(filepath.Join(root, "projects", "*", "*.jsonl"))
	read := 0
	for _, path := range paths {
		id := strings.TrimSuffix(filepath.Base(path), ".jsonl")
		if !sessionID.MatchString(id) {
			continue
		}
		if _, err := verifiedRegular(root, path); err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.Size() > maxScanBytes {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		// Offline audit only: visit every saved branch, including old requests.
		var leaves []string
		if err := nativeLines(data, func(line []byte) error {
			var row struct{ Type, ID string }
			if json.Unmarshal(line, &row) != nil {
				return ErrUnavailable
			}
			if row.Type != "session" {
				leaves = append(leaves, row.ID)
			}
			return nil
		}); err != nil {
			continue
		}
		seen := map[string]bool{}
		for _, leaf := range leaves {
			ref := Ref{Source: "pairfob:cmd", Agent: "cmd", Kind: "id", Value: id, Leaf: &leaf}
			records, _, err := r.parseCommandCodeSession(data, ref, path)
			if err != nil {
				continue
			}
			for _, record := range records {
				if (record.Kind != storeUser && record.Kind != storeCommand) || seen[record.Text] {
					continue
				}
				seen[record.Text] = true
				reportInjected(t, "cmd", path, parsedEvent{Event: Event{Type: record.Kind, Text: record.Text}})
			}
		}
		read++
	}
	t.Logf("cmd: %d native transcripts audited (zero means no local acceptance evidence)", read)
}
