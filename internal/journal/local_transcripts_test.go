package journal

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Agent CLIs change their private transcript formats without notice. After an
// agent upgrade, run this against the real transcripts on a development
// machine to catch injected context that new versions leak into chat:
//
//	PAIRFOB_SCAN_LOCAL_TRANSCRIPTS=1 go test ./internal/journal -run LocalTranscripts -v
//
// A hit prints the file and a snippet. Text a person really typed (pasted
// HTML, for example) can match; anything else needs a filter in
// transcript_filter.go and a fixture test.
var injectedLooking = regexp.MustCompile(`(?m)^\s*<[A-Za-z][A-Za-z0-9_-]*[ >]|\[Request interrupted|<local-command-caveat>|Base directory for this skill|\[Image: original|^# AGENTS\.md instructions`)

func TestLocalTranscriptsShowNoInjectedContext(t *testing.T) {
	if os.Getenv("PAIRFOB_SCAN_LOCAL_TRANSCRIPTS") != "1" {
		t.Skip("set PAIRFOB_SCAN_LOCAL_TRANSCRIPTS=1 to scan this machine's agent transcripts")
	}
	reader := NewDefault()
	sources := []struct {
		name    string
		glob    string
		parse   traceParser
		history func([]byte) (Message, bool)
	}{
		{"claude", filepath.Join(reader.ClaudeRoot, "projects", "*", "*.jsonl"), parseClaudeTrace, parseClaude},
		{"codex", filepath.Join(reader.CodexRoot, "sessions", "*", "*", "*", "*.jsonl"), parseCodexTrace, parseCodex},
		{"grok", filepath.Join(reader.GrokRoot, "sessions", "*", "*", "updates.jsonl"), parseGrokTrace, parseGrok},
	}
	for _, source := range sources {
		files, _ := filepath.Glob(source.glob)
		heads := 0
		for _, path := range files {
			// History is the older RPC with its own parsers; scan it as user turns.
			history := func(line []byte) []parsedEvent {
				if message, ok := source.history(line); ok && message.Role == "user" {
					return []parsedEvent{{Event: Event{Type: "user", Text: message.Text}}}
				}
				return nil
			}
			for _, ev := range scanLocalTranscript(t, path, history) {
				reportInjected(t, source.name+" history", path, ev)
			}
			for _, ev := range scanLocalTranscript(t, path, source.parse) {
				if !turnHead(ev.Type) {
					continue
				}
				heads++
				reportInjected(t, source.name, path, ev)
			}
		}
		t.Logf("%s: %d transcripts, %d prompts/commands", source.name, len(files), heads)
	}
	piFiles, _ := filepath.Glob(filepath.Join(reader.PiRoot, "sessions", "*", "*.jsonl"))
	for _, path := range piFiles {
		session, err := parsePiSessionFile(path)
		if err != nil {
			continue
		}
		for _, ev := range piEvents(session) {
			if turnHead(ev.Type) {
				reportInjected(t, "pi", path, ev)
			}
		}
	}
	t.Logf("pi: %d transcripts", len(piFiles))
}

func scanLocalTranscript(t *testing.T, path string, parse traceParser) []parsedEvent {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	var events []parsedEvent
	if err := forEachLine(file, maxTraceLine, func(line []byte, _ int, oversized bool) bool {
		if oversized {
			t.Logf("%s: skipped a record over %d bytes", filepath.Base(path), maxTraceLine)
		} else {
			events = append(events, parse(line)...)
		}
		return true
	}); err != nil {
		t.Errorf("%s: %v", path, err)
	}
	return events
}

func reportInjected(t *testing.T, agent, path string, ev parsedEvent) {
	t.Helper()
	if !injectedLooking.MatchString(ev.Text) {
		return
	}
	snippet := strings.ReplaceAll(ev.Text, "\n", "⏎")
	if len(snippet) > 160 {
		snippet = snippet[:160] + "…"
	}
	t.Errorf("%s %s %s: %q", agent, filepath.Base(path), ev.Type, snippet)
}

func parsePiSessionFile(path string) (*piSession, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parsePiSession(path, data, Ref{Source: "herdr:pi", Agent: "pi", Kind: "path", Value: path})
}
