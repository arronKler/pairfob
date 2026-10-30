package journal

import "path/filepath"

// One place names what each line-based agent needs: the directory its
// transcripts live under and the parsers that read one record. Hermes and
// opencode sessions are rendered into lines first (store.go). Pi keeps a
// session tree instead of an append-only log and has its own reader (pi.go).

func historyParserFor(agent string) func([]byte) (Message, bool) {
	if storeAgent(agent) {
		return parseStore
	}
	switch agent {
	case "codex":
		return parseCodex
	case "claude":
		return parseClaude
	case "cursor":
		return parseCursor
	case "copilot":
		return parseCopilot
	case "grok":
		return parseGrok
	default:
		return func([]byte) (Message, bool) { return Message{}, false }
	}
}

func traceParserFor(agent string) traceParser {
	if storeAgent(agent) {
		return parseStoreTrace
	}
	switch agent {
	case "codex":
		return parseCodexTrace
	case "claude":
		return parseClaudeTrace
	case "cursor":
		return parseCursorTrace
	case "copilot":
		return parseCopilotTrace
	case "grok":
		return parseGrokTrace
	default:
		return func([]byte) []parsedEvent { return nil }
	}
}

// transcriptBase is the provider directory periodic reads are confined to.
func (r *Reader) transcriptBase(agent string) string {
	switch agent {
	case "codex":
		return filepath.Join(r.CodexRoot, "sessions")
	case "claude":
		return filepath.Join(r.ClaudeRoot, "projects")
	case "pi", "prime-agent":
		return r.piSessionsDir(agent)
	case "cursor":
		return filepath.Join(r.CursorRoot, "projects")
	case "copilot", "kimi":
		return r.NativeRoots[agent]
	default:
		return filepath.Join(r.GrokRoot, "sessions")
	}
}
