package journal

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Codex code mode ("exec") runs a JavaScript snippet that calls the ordinary
// tools, e.g. text(await tools.exec_command({cmd:"rg -n x"})). Its label is the
// first call's command, or the tool and its first target, plus " +N" for the
// further calls in the same snippet.
var (
	codeModeCall = regexp.MustCompile(`tools\.([A-Za-z0-9_]+)\(`)
	codeModeArg  = regexp.MustCompile(`\b(cmd|command|q|query|ref_id|url|path)"?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`)
)

func codeModeLabel(code string) string {
	calls := codeModeCall.FindAllStringSubmatchIndex(code, -1)
	if len(calls) == 0 {
		return ""
	}
	tool := code[calls[0][2]:calls[0][3]]
	label := tool
	if arg := codeModeArg.FindStringSubmatch(code[calls[0][1]:]); arg != nil {
		value := jsString(arg[2])
		if arg[1] == "cmd" || arg[1] == "command" {
			label = commandLine(mustJSON(value))
		} else if value != "" {
			label = tool + " · " + value
		}
	}
	if more := len(calls) - 1; more > 0 && label != "" {
		label += " +" + strconv.Itoa(more)
	}
	return label
}

// jsString decodes a double-quoted (JSON-compatible) or single-quoted JS literal.
func jsString(literal string) string {
	if strings.HasPrefix(literal, "'") {
		inner := strings.TrimSuffix(strings.TrimPrefix(literal, "'"), "'")
		return strings.NewReplacer(`\'`, `'`, `\\`, `\`, `\n`, "\n").Replace(inner)
	}
	var value string
	if json.Unmarshal([]byte(literal), &value) != nil {
		return ""
	}
	return value
}

func mustJSON(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
