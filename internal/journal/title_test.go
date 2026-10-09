package journal

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func titleFixture(t *testing.T) (*Reader, Ref, string) {
	t.Helper()
	r := &Reader{CodexRoot: t.TempDir()}
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "title_session_1234"}
	path := filepath.Join(r.CodexRoot, "sessions", "rollout-"+ref.Value+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	return r, ref, path
}

func titleUser(text string) string {
	record := map[string]any{"type": "response_item", "payload": map[string]any{
		"type": "message", "role": "user", "content": []map[string]string{{"type": "input_text", "text": text}},
	}}
	data, _ := json.Marshal(record)
	return string(data) + "\n"
}

func TestTitleFirstRealRequestWithoutInjectedContextOrAttachmentPath(t *testing.T) {
	r, ref, path := titleFixture(t)
	text := titleUser("# AGENTS.md instructions for /repo\n<INSTRUCTIONS>secret setup</INSTRUCTIONS>") +
		titleUser("<environment_context>private environment</environment_context>") +
		titleUser("/Users/test/repo/.pairfob/attachments/abc/attachment.jpg 请修复会话标题\n同时检查列表") + titleUser("继续")
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	if got := r.ReadTitle(ref); got.Name != "" || got.Prompt != "请修复会话标题 同时检查列表" {
		t.Fatalf("title=%+v", got)
	}
	// A new daemon derives the same name; a later follow-up never renames it.
	if got := (&Reader{CodexRoot: r.CodexRoot}).ReadTitle(ref); got.Prompt != "请修复会话标题 同时检查列表" {
		t.Fatalf("restart=%+v", got)
	}
}

func TestTitleNativeNameArrivesAfterPromptAndIsScopedToExactSession(t *testing.T) {
	r, ref, _ := titleFixture(t)
	if err := os.WriteFile(filepath.Join(r.CodexRoot, "state_5.sqlite"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(100, 0)
	r.now = func() time.Time { return now }
	name, calls := "", 0
	r.sqlite = func(_ context.Context, db, query string) ([]byte, error) {
		calls++
		if filepath.Base(db) != "state_5.sqlite" || !strings.Contains(query, "where id='"+ref.Value+"'") || strings.Contains(query, "cwd=") {
			t.Fatalf("unsafe title query: %s %s", db, query)
		}
		return json.Marshal([]map[string]string{{"id": ref.Value, "name": name, "prompt": "Fix the mobile session title"}})
	}
	if got := r.ReadTitle(ref); got.Prompt != "Fix the mobile session title" || got.Name != "" {
		t.Fatalf("initial=%+v", got)
	}
	name = "修复会话标题"
	if got := r.ReadTitle(ref); got.Name != "" || calls != 1 {
		t.Fatalf("cache=%+v calls=%d", got, calls)
	}
	now = now.Add(3 * time.Second)
	if got := r.ReadTitle(ref); got.Name != name || calls != 2 {
		t.Fatalf("refresh=%+v calls=%d", got, calls)
	}
	for _, invalid := range []Ref{{Agent: "codex", Kind: "id", Value: ref.Value}, {Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "id' OR 1=1"}, {Source: "herdr:codex", Agent: "codex", Kind: "path", Value: "/private/session"}} {
		if got := r.ReadTitle(invalid); got != (Title{}) || calls != 2 {
			t.Fatalf("untrusted binding read: %+v", got)
		}
	}
}

func TestTitleUnavailableDatabaseFallsBackWithoutReadingAnotherSession(t *testing.T) {
	r, ref, path := titleFixture(t)
	if err := os.WriteFile(path, []byte(titleUser("First request")), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.CodexRoot, "state_5.sqlite"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	r.sqlite = func(context.Context, string, string) ([]byte, error) { return nil, errors.New("missing name column") }
	if got := r.ReadTitle(ref); got.Prompt != "First request" {
		t.Fatalf("fallback=%+v", got)
	}
	r.titleCache = nil
	r.sqlite = func(context.Context, string, string) ([]byte, error) {
		return []byte(`[{"id":"another_session","name":"Must not leak","prompt":"Private"}]`), nil
	}
	if got := r.ReadTitle(ref); got.Name != "" || got.Prompt != "First request" {
		t.Fatalf("cross-session=%+v", got)
	}
}

func TestTitleConfinesFilesAndBoundsExcerpt(t *testing.T) {
	r, ref, path := titleFixture(t)
	outside := filepath.Join(t.TempDir(), "private.jsonl")
	if err := os.WriteFile(outside, []byte(titleUser("Must not leak")), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if got := r.ReadTitle(ref); got != (Title{}) {
		t.Fatalf("symlink=%+v", got)
	}
	got := promptTitle("\u202e" + strings.Repeat("中文", 100))
	if len([]rune(got)) != 72 || strings.Contains(got, "\u202e") || !strings.HasSuffix(got, "…") {
		t.Fatalf("excerpt=%q", got)
	}
}

func TestTitleDropsCodexImageReferenceButKeepsItsRequest(t *testing.T) {
	text := "<image name=[Image #1] path=\"/private/attachment.jpg\">\n</image>\n检查这个布局"
	if got := promptTitle(text); got != "检查这个布局" {
		t.Fatalf("image title=%q", got)
	}
	if got := visibleCodexUserText("Explain this markup:\n" + text); got != "Explain this markup:\n"+text {
		t.Fatal("user's own markup was removed")
	}
}

func TestLocalTranscriptsCodexTitle(t *testing.T) {
	if os.Getenv("PAIRFOB_SCAN_LOCAL_TRANSCRIPTS") != "1" || os.Getenv("CODEX_THREAD_ID") == "" {
		t.Skip("requires an explicit local scan inside a Codex session")
	}
	r := NewDefault()
	ref := Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: os.Getenv("CODEX_THREAD_ID")}
	got := r.ReadTitle(ref)
	if got == (Title{}) {
		t.Fatal("current Codex session has neither native name nor a readable request")
	}
	if strings.Contains(got.Prompt, ".pairfob/attachments/") || strings.HasPrefix(got.Prompt, "<") || strings.HasPrefix(got.Prompt, "# AGENTS.md") {
		t.Fatal("title contains attachment or injected context")
	}
	t.Logf("current session: native name present=%t, prompt excerpt length=%d", got.Name != "", len([]rune(got.Prompt)))
}
