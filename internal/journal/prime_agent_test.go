package journal

import (
	"os"
	"path/filepath"
	"testing"
)

// Prime Agent is a Pi fork: its sessions carry the same header and entry tree,
// and Herdr binds them through the herdr:pi source under the prime-agent name.
func primeFixture(t *testing.T, lines ...any) (*Reader, Ref, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	const id = "0199a1b2-0000-7000-8000-000000000001"
	path := filepath.Join(dir, id+".jsonl")
	data := piLine(map[string]any{"type": "session", "version": 3, "id": id, "cwd": "/work"})
	for _, line := range lines {
		data = append(data, piLine(line)...)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return &Reader{PrimeRoot: root}, Ref{Source: "herdr:pi", Agent: "prime-agent", Kind: "path", Value: path}, path
}

func TestPrimeAgentSupportsOnlyItsOwnTree(t *testing.T) {
	reader, ref, path := primeFixture(t)
	if !reader.Supports(ref) {
		t.Fatal("prime-agent path binding was not supported")
	}
	if !reader.Available(ref) {
		t.Fatal("prime-agent fixture was not available")
	}
	if !reader.Supports(Ref{Source: "herdr:pi", Agent: "prime-agent", Kind: "id", Value: "0199a1b2-0000-7000-8000-000000000001"}) {
		t.Fatal("prime-agent id binding was not supported")
	}
	if reader.Supports(Ref{Source: "phone", Agent: "prime-agent", Kind: "path", Value: path}) {
		t.Fatal("prime-agent accepted a non-Herdr source")
	}
	piReader := &Reader{PiRoot: t.TempDir()}
	if piReader.Supports(ref) {
		t.Fatal("the Pi root accepted a prime-agent session outside its tree")
	}
	if reader.Supports(Ref{Source: "herdr:pi", Agent: "pi", Kind: "path", Value: path}) {
		t.Fatal("the prime root accepted a Pi binding")
	}
	outside := filepath.Join(t.TempDir(), "session.jsonl")
	if reader.Supports(Ref{Source: "herdr:pi", Agent: "prime-agent", Kind: "path", Value: outside}) {
		t.Fatal("prime-agent accepted a path outside its sessions directory")
	}
	if reader.Supports(Ref{Source: "herdr:pi", Agent: "prime-agent", Kind: "path", Value: path + "/../escape.jsonl"}) {
		t.Fatal("prime-agent accepted a parent traversal")
	}
}

func TestPrimeAgentReadsHistoryTraceAndTitle(t *testing.T) {
	reader, ref, _ := primeFixture(t,
		msg("user0001", nil, "user", []any{map[string]any{"type": "text", "text": "run the tests"}}),
		msg("asst0001", "user0001", "assistant", []any{
			map[string]any{"type": "text", "text": "running"},
			map[string]any{"type": "toolCall", "id": "call-one", "name": "python_repl", "arguments": map[string]any{"code": "print(1)"}},
		}),
		map[string]any{"type": "message", "id": "tool0001", "parentId": "asst0001", "message": map[string]any{"role": "toolResult", "toolCallId": "call-one", "toolName": "python_repl", "content": []any{map[string]any{"type": "text", "text": "1"}}, "isError": false}},
	)
	page, err := reader.Read(ref, nil, 50)
	if err != nil || len(page.Messages) != 2 || page.Messages[0].Text != "run the tests" {
		t.Fatalf("history = %+v, err = %v", page, err)
	}
	trace, err := reader.ReadTrace(ref, nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	var tool *Event
	for i := range trace.Items {
		if trace.Items[i].Type == "tool" {
			tool = &trace.Items[i]
		}
	}
	if tool == nil || tool.Name != "python_repl" || tool.State != "done" || tool.Output != "1" {
		t.Fatalf("tool event = %+v", tool)
	}
	if title := reader.ReadTitle(ref); title.Prompt != "run the tests" {
		t.Fatalf("title = %+v", title)
	}
}

func TestPrimeAgentSessionDirOverride(t *testing.T) {
	_, ref, path := primeFixture(t)
	dir := filepath.Dir(path)
	override := &Reader{PrimeRoot: t.TempDir(), PrimeSessionDir: dir}
	if !override.Supports(ref) || !override.Available(ref) {
		t.Fatal("PRIME_AGENT_SESSION_DIR override was not honored")
	}
	if _, err := override.Read(ref, nil, 50); err != nil {
		t.Fatal(err)
	}
	if (&Reader{}).Supports(ref) {
		t.Fatal("an unconfigured reader accepted a prime-agent binding")
	}
}
