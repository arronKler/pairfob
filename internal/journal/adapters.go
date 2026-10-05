package journal

import "path/filepath"

// One place names what each line-based agent needs: the directory its
// transcripts live under and the parsers that read one record. Hermes and
// opencode sessions are rendered into lines first (store.go). Pi keeps a
// session tree instead of an append-only log and has its own reader (pi.go).

func historyParserFor(agent string) func([]byte) (Message, bool) {
	switch agent {
	case "codex":
		return parseCodex
	case "claude":
		return parseClaude
	case "cursor":
		return parseCursor
	case "hermes", "opencode":
		return parseStore
	default:
		return parseGrok
	}
}

func traceParserFor(agent string) traceParser {
	switch agent {
	case "codex":
		return parseCodexTrace
	case "claude":
		return parseClaudeTrace
	case "cursor":
		return parseCursorTrace
	case "hermes", "opencode":
		return parseStoreTrace
	default:
		return parseGrokTrace
	}
}

// transcriptBase is the provider directory periodic reads are confined to.
func (r *Reader) transcriptBase(agent string) string {
	switch agent {
	case "codex":
		return filepath.Join(r.CodexRoot, "sessions")
	case "claude":
		return filepath.Join(r.ClaudeRoot, "projects")
	case "pi":
		return filepath.Join(r.PiRoot, "sessions")
	case "cursor":
		return filepath.Join(r.CursorRoot, "projects")
	default:
		return filepath.Join(r.GrokRoot, "sessions")
	}
}
