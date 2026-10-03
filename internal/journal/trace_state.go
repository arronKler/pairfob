package journal

import (
	"encoding/json"
	"strconv"
	"strings"
)

// traceToolState reports running, done or error for a summary tool item. A
// state the agent recorded wins over guessing from the output text.
func traceToolState(item Event) string {
	if item.State == "done" || item.State == "error" {
		return item.State
	}
	if item.Output == "" {
		return "running"
	}
	switch strings.ToLower(strings.TrimSpace(item.Output)) {
	case "失败", "failed", "error", "errored":
		return "error"
	default:
		return "done"
	}
}

// attachOutput moves an output-only record onto its tool, keeping any state
// the output record carried.
func attachOutput(tool *parsedEvent, output parsedEvent) {
	tool.Output = output.Output
	if output.State != "" {
		tool.State = output.State
	}
}

// codexMaxStatusLines bounds the status header search when an output has no
// "Output:" line separating the header from the command's own text.
const codexMaxStatusLines = 16

// codexOutputState reads the outcome Codex prints with a tool output: the
// "Process exited with code N" or "Exit code: N" status header, a JSON
// exit_code (top level or under metadata), or its own failure notices. It
// returns "" when the output carries no outcome.
func codexOutputState(output string) string {
	header, body := splitCodexOutput(output)
	first, _, _ := strings.Cut(header, "\n")
	if strings.TrimSpace(first) == "Script failed" || strings.HasPrefix(output, "apply_patch verification failed") {
		return "error"
	}
	code, ok := codexHeaderExitCode(header)
	if !ok {
		code, ok = codexJSONExitCode(body)
	}
	switch {
	case !ok:
		return ""
	case code == 0:
		return "done"
	default:
		return "error"
	}
}

// splitCodexOutput separates the status header from the command output at the
// first "Output:" line. Without one, the header is the first few lines and the
// body is the whole text.
func splitCodexOutput(output string) (string, string) {
	if strings.HasPrefix(output, "Output:\n") {
		return "", output[len("Output:\n"):]
	}
	if index := strings.Index(output, "\nOutput:\n"); index >= 0 {
		return output[:index], output[index+len("\nOutput:\n"):]
	}
	if header, ok := strings.CutSuffix(output, "\nOutput:"); ok {
		return header, ""
	}
	end := 0
	for range codexMaxStatusLines {
		next := strings.IndexByte(output[end:], '\n')
		if next < 0 {
			return output, output
		}
		end += next + 1
	}
	return output[:end], output
}

func codexHeaderExitCode(header string) (int, bool) {
	for line := range strings.Lines(header) {
		line = strings.TrimSpace(line)
		for _, prefix := range []string{"Process exited with code ", "Exit code: "} {
			if rest, ok := strings.CutPrefix(line, prefix); ok {
				if code, err := strconv.Atoi(rest); err == nil {
					return code, true
				}
			}
		}
	}
	return 0, false
}

func codexJSONExitCode(body string) (int, bool) {
	body = strings.TrimSpace(body)
	if !strings.HasPrefix(body, "{") || !strings.HasSuffix(body, "}") {
		return 0, false
	}
	var result struct {
		ExitCode *int `json:"exit_code"`
		Metadata *struct {
			ExitCode *int `json:"exit_code"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(body), &result) != nil {
		return 0, false
	}
	if result.ExitCode != nil {
		return *result.ExitCode, true
	}
	if result.Metadata != nil && result.Metadata.ExitCode != nil {
		return *result.Metadata.ExitCode, true
	}
	return 0, false
}
