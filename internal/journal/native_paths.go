package journal

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func defaultNativeRoots(home, dataHome string) map[string]string {
	kimi := os.Getenv("KIMI_SHARE_DIR")
	if kimi == "" {
		kimi = filepath.Join(home, ".kimi")
	}
	copilot := os.Getenv("COPILOT_HOME")
	if copilot == "" {
		copilot = filepath.Join(home, ".copilot")
	}
	cline := os.Getenv("CLINE_SESSION_DATA_DIR")
	if cline == "" {
		base := os.Getenv("CLINE_DATA_DIR")
		if base == "" {
			base = os.Getenv("CLINE_DIR")
			if base == "" {
				base = filepath.Join(home, ".cline")
			}
			base = filepath.Join(base, "data")
		}
		cline = filepath.Join(base, "sessions")
	}
	return map[string]string{
		"cline":     cline,
		"cmd":       filepath.Join(home, ".commandcode"),
		"copilot":   copilot,
		"kimi":      kimi,
		"kimi-code": nativeRoot("KIMI_CODE_HOME", filepath.Join(home, ".kimi-code")),
		"gemini":    filepath.Join(home, ".gemini"),
		"qwen":      nativeRoot("QWEN_HOME", filepath.Join(home, ".qwen")),
		"kilo":      filepath.Join(dataHome, "kilo"),
		"amp":       filepath.Join(nativeRoot("AMP_DATA_HOME", dataHome), "amp"),
		"droid":     nativeRoot("FACTORY_DIR", filepath.Join(home, ".factory")),
		"maki":      defaultMakiRoot(home),
		"devin":     defaultDevinRoot(home, dataHome),
		"kiro":      nativeRoot("KIRO_HOME", filepath.Join(home, ".kiro")),
		"qodercli":  filepath.Join(home, ".qoder"),
		"muse":      filepath.Join(dataHome, "muse"),
		"agy":       filepath.Join(home, ".gemini", "antigravity-cli"),
		"letta":     nativeRoot("LETTA_TRANSCRIPT_ROOT", filepath.Join(home, ".letta", "transcripts")),
	}
}

func nativeAgent(agent string) bool {
	switch agent {
	case "cmd", "copilot", "kimi", "gemini", "qwen", "kilo", "cline", "amp", "droid", "maki", "muse", "agy", "letta", "qodercli", "kiro", "devin":
		return true
	}
	return false
}

func (r *Reader) nativeTranscriptPath(ref Ref) (string, error) {
	root := r.NativeRoots[ref.Agent]
	if root == "" {
		return "", ErrUnavailable
	}
	switch ref.Agent {
	case "cmd":
		return uniqueNativeFile(root, filepath.Join(root, "projects", "*", ref.Value+".jsonl"))
	case "muse":
		return uniqueNativeFile(root, filepath.Join(root, "sessions", "*", "*", "*", ref.Value, "session.jsonl"))
	case "agy":
		return verifiedRegular(root, filepath.Join(root, "brain", ref.Value, ".system_generated", "logs", "transcript.jsonl"))
	case "letta":
		if strings.HasPrefix(ref.Value, "default:agent-") {
			return verifiedRegular(root, filepath.Join(root, strings.TrimPrefix(ref.Value, "default:"), "default", "transcript.jsonl"))
		}
		return uniqueNativeFile(root, filepath.Join(root, "agent-*", ref.Value, "transcript.jsonl"))
	case "qodercli":
		return uniqueNativeFile(root, filepath.Join(root, "projects", "*", "transcript", ref.Value+".jsonl"))
	case "kiro":
		return r.kiroTranscriptPath(ref)
	case "amp":
		return verifiedRegular(root, filepath.Join(root, "threads", ref.Value+".json"))
	case "maki":
		return verifiedRegular(root, filepath.Join(root, "sessions", ref.Value+".jsonl"))
	case "droid":
		return uniqueNativeFile(root, filepath.Join(root, "sessions", "*", ref.Value+".jsonl"))
	case "cline":
		return verifiedRegular(root, filepath.Join(root, ref.Value, ref.Value+".messages.json"))
	case "gemini":
		return r.geminiTranscriptPath(ref)
	case "qwen":
		paths, err := filepath.Glob(filepath.Join(root, "projects", "*", "chats", ref.Value+".jsonl"))
		if err != nil || len(paths) != 1 {
			return "", ErrUnavailable
		}
		return verifiedRegular(root, paths[0])
	case "copilot":
		return verifiedRegular(root, filepath.Join(root, "session-state", ref.Value, "events.jsonl"))
	case "kimi":
		return r.kimiTranscriptPath(ref)
	}
	return "", ErrUnavailable
}

func (r *Reader) nativeLineTitle(ref Ref) (Title, bool) {

	// Copilot's session.title_changed is ephemeral, not part of events.jsonl.
	// Its persisted real user message is the stable title fallback.
	return r.lineTitle(ref)
}

func nativeRoot(env, fallback string) string {
	if value := os.Getenv(env); value != "" {
		return value
	}
	return fallback
}

func uniqueNativeFile(root, pattern string) (string, error) {
	paths, err := filepath.Glob(pattern)
	if err != nil || len(paths) != 1 {
		return "", ErrUnavailable
	}
	return verifiedRegular(root, paths[0])
}

func defaultMakiRoot(home string) string {
	legacy := filepath.Join(home, ".maki")
	if info, err := os.Stat(legacy); err == nil && info.IsDir() {
		return legacy
	}
	return filepath.Join(nativeRoot("XDG_STATE_HOME", filepath.Join(home, ".local", "state")), "maki")
}

func defaultDevinRoot(home, dataHome string) string {
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "devin", "cli")
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("APPDATA"), "devin", "cli")
	}
	return filepath.Join(dataHome, "devin", "cli")
}
