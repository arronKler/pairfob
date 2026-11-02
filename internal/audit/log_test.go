package audit

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func readLines(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open %s: %v", path, err)
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return lines
}

func decode(t *testing.T, line string) map[string]any {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal([]byte(line), &record); err != nil {
		t.Fatalf("invalid JSON line %q: %v", line, err)
	}
	return record
}

func TestEventSurvivesRotation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first.Event("first", map[string]any{"pad": strings.Repeat("x", 40)})
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	// A cap one byte above the file makes the very next event rotate.
	l, err := Open(path, WithMaxBytes(info.Size()+1))
	if err != nil {
		t.Fatalf("Open with cap: %v", err)
	}
	l.Event("second", map[string]any{"pad": strings.Repeat("y", 40)})
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	active := readLines(t, path)
	if len(active) != 1 {
		t.Fatalf("active lines = %d, want 1: %v", len(active), active)
	}
	if got := decode(t, active[0])["op"]; got != "second" {
		t.Fatalf("active op = %v, want second", got)
	}
	if !strings.HasSuffix(active[0], "}") {
		t.Fatalf("active event was split: %q", active[0])
	}

	backupLines := readLines(t, path+".1")
	if len(backupLines) != 1 {
		t.Fatalf("backup lines = %d, want 1: %v", len(backupLines), backupLines)
	}
	if got := decode(t, backupLines[0])["op"]; got != "first" {
		t.Fatalf("backup op = %v, want first", got)
	}

	for _, name := range []string{path, path + ".1"} {
		st, err := os.Stat(name)
		if err != nil {
			t.Fatalf("Stat %s: %v", name, err)
		}
		if perm := st.Mode().Perm(); perm != 0600 {
			t.Fatalf("%s mode = %o, want 0600", name, perm)
		}
	}
}

func TestOpenRejectsSymlinkAndDirectory(t *testing.T) {
	dir := t.TempDir()
	if _, err := Open(dir); err == nil {
		t.Fatal("Open accepted a directory")
	}
	target := filepath.Join(dir, "target.log")
	if err := os.WriteFile(target, []byte{}, 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	link := filepath.Join(dir, "audit.log")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	if _, err := Open(link); err == nil {
		t.Fatal("Open accepted a symlink")
	}
}

func TestConcurrentEventsStayWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := Open(path, WithMaxBytes(512))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	const writers, perWriter = 8, 25
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < perWriter; j++ {
				l.Event("probe", map[string]any{"n": j, "pad": strings.Repeat("z", 50)})
			}
		}()
	}
	wg.Wait()
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Only the newest backup survives with one backup slot, so the assertion
	// is that every surviving line is a whole event, not that all of them
	// remain.
	kept := 0
	for _, name := range []string{path, path + ".1"} {
		st, err := os.Stat(name)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("Stat %s: %v", name, err)
		}
		if perm := st.Mode().Perm(); perm != 0600 {
			t.Fatalf("%s mode = %o, want 0600", name, perm)
		}
		for _, line := range readLines(t, name) {
			record := decode(t, line)
			if record["op"] != "probe" || record["pad"] != strings.Repeat("z", 50) {
				t.Fatalf("damaged event in %s: %q", name, line)
			}
			kept++
		}
	}
	if kept == 0 {
		t.Fatal("no events were written")
	}
}

func TestNilLoggerIsSafe(t *testing.T) {
	var l *Logger
	l.Event("ignored", nil)
	if err := l.Close(); err != nil {
		t.Fatalf("Close on nil: %v", err)
	}
}
