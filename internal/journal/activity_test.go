package journal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestActivityIgnoresStartupAndFindsRealCodexTask(t *testing.T) {
	startup := `{"type":"session_meta","payload":{"id":"test"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\nArbitrary project setup"}]}}
{"type":"turn_context","payload":{}}
`
	if got := scanActivity("codex", []byte(startup), 0); !got.Known || got.Key != "" {
		t.Fatalf("startup counted as a task: %+v", got)
	}
	for _, event := range []string{"task_started", "user_message", "task_complete"} {
		got := scanActivity("codex", []byte(startup+`{"type":"event_msg","payload":{"type":"`+event+`"}}`+"\n"), 0)
		if !got.Known || len(got.Key) != 64 {
			t.Fatalf("%s evidence=%+v", event, got)
		}
	}
	output := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}` + "\n"
	if got := scanActivity("codex", []byte(output), 0); got.Key == "" {
		t.Fatal("older Codex output was lost")
	}
	legacyPrompt := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Actual task"}]}}` + "\n"
	if got := scanActivity("codex", []byte(legacyPrompt), 0); got.Key == "" {
		t.Fatal("legacy user task was treated as startup context")
	}
}

func TestActivityCacheTracksNewTasksNotMetadata(t *testing.T) {
	root := t.TempDir()
	id := "activity_session_1234"
	path := filepath.Join(root, "sessions", "rollout-"+id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(text string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	reader := &Reader{CodexRoot: root}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: id}
	text := `{"type":"event_msg","payload":{"type":"user_message","message":"same question"}}` + "\n"
	write(text)
	first := reader.ReadActivity(ref)
	if first.Key == "" || reader.ReadActivity(ref) != first {
		t.Fatalf("cache=%+v", first)
	}
	metadata := `{"type":"session_meta","payload":{"id":"activity_session_1234"}}` + "\n"
	write(text + metadata)
	if next := reader.ReadActivity(ref); next != first {
		t.Fatalf("metadata changed task: %+v", next)
	}
	write(text + metadata + text)
	if next := reader.ReadActivity(ref); next.Key == first.Key || next.Key == "" {
		t.Fatalf("repeated task did not advance: %+v", next)
	}
	write(metadata)
	if next := reader.ReadActivity(ref); !next.Known || next.Key != "" {
		t.Fatalf("truncation kept old task: %+v", next)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if next := reader.ReadActivity(ref); next.Known || next.Key != "" {
		t.Fatalf("missing file guessed success: %+v", next)
	}
}

func TestActivityBoundedTailAndPartialRecords(t *testing.T) {
	for _, data := range []string{`{"type":"event_msg"`, "broken\n", strings.Repeat("x", activityReadBytes)} {
		if got := scanActivity("codex", []byte(data), 0); got.Known || got.Key != "" {
			t.Fatalf("invalid record=%+v", got)
		}
	}
	if got := scanActivity("codex", []byte("partial\n{}\n"), 10); got.Known {
		t.Fatal("unseen older records treated as empty")
	}
	if got := (&Reader{}).ReadActivity(Ref{Agent: "unsupported"}); got.Known {
		t.Fatal("unsupported guessed idle")
	}
}

func TestActivityCountsClaudeSlashCommandSubmission(t *testing.T) {
	command := `{"type":"user","message":{"role":"user","content":"<command-name>/pstack:poteto-mode</command-name>\n<command-args>fix the list title</command-args>"}}` + "\n"
	got := scanActivity("claude", []byte(command), 0)
	// The command itself is a submission, not yet the task's model work: it
	// must not change completion evidence.
	if !got.Known || !got.Submitted || got.Key != "" {
		t.Fatalf("slash command submission=%+v", got)
	}
	// Injected command output is not a submission.
	output := `{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to Opus</local-command-stdout>"}}` + "\n"
	if got := scanActivity("claude", []byte(output), 0); !got.Known || got.Submitted || got.Key != "" {
		t.Fatalf("command output became a submission: %+v", got)
	}
}

func TestActivityOtherProvidersAndPiBranch(t *testing.T) {
	claude := `{"type":"user","message":{"role":"user","content":"go"}}` + "\n"
	if got := scanActivity("claude", []byte(claude), 0); got.Key == "" {
		t.Fatal("Claude prompt missing")
	}
	reader, ref, path := piFixture(t,
		msg("old-task", nil, "user", "old branch"),
		map[string]any{"type": "custom_message", "id": "welcome01", "parentId": nil, "display": true, "content": "Welcome"},
	)
	if got := reader.ReadActivity(ref); !got.Known || got.Key != "" {
		t.Fatalf("abandoned branch/extension became task: %+v", got)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Write(piLine(msg("new-task", "welcome01", "user", "go")))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if got := reader.ReadActivity(ref); got.Key == "" {
		t.Fatal("active Pi prompt missing")
	}
}
