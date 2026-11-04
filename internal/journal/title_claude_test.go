package journal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func claudeTitleFixture(t *testing.T) (*Reader, Ref, string) {
	t.Helper()
	r := &Reader{ClaudeRoot: t.TempDir()}
	ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: "claude_title_session"}
	path := filepath.Join(r.ClaudeRoot, "projects", "-repo", ref.Value+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	return r, ref, path
}

func appendClaudeTitleRecord(t *testing.T, path string, record any) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(record); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeTitleFirstRequestSkipsCommandsAndInjectedContext(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	for _, record := range []any{
		claudeUser("Private skill instructions", map[string]any{"isMeta": true}),
		claudeUser("Subagent request", map[string]any{"isSidechain": true}),
		claudeUser("Compacted request", map[string]any{"isCompactSummary": true}),
		claudeUser("Transcript note", map[string]any{"isVisibleInTranscriptOnly": true}),
		claudeUser("<command-name>/clear</command-name>", nil),
		claudeUser("<bash-input>pwd</bash-input>", nil),
		claudeUser("[Request interrupted by user]", nil),
		claudeUser("<task-notification>Private task output</task-notification>", nil),
		claudeUser([]map[string]any{
			{"type": "tool_result", "content": "Private tool output"},
			{"type": "image", "source": map[string]string{"data": "PRIVATE_IMAGE"}},
			{"type": "text", "text": "<system-reminder>Private context</system-reminder>\n/tmp/.pairfob/attachments/abc/a.png 修复 Claude 会话标题"},
		}, nil),
		claudeUser("继续", nil),
	} {
		appendClaudeTitleRecord(t, path, record)
	}
	want := Title{Prompt: "修复 Claude 会话标题"}
	if got := r.ReadTitle(ref); got != want {
		t.Fatalf("title=%+v", got)
	}
	if got := (&Reader{ClaudeRoot: r.ClaudeRoot}).ReadTitle(ref); got != want {
		t.Fatalf("restart=%+v", got)
	}
}

func TestClaudeTitleUsesSlashCommandRequest(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	now := time.Unix(100, 0)
	r.now = func() time.Time { return now }
	appendClaudeTitleRecord(t, path, claudeUser("<command-message>pstack:poteto-mode</command-message>\n"+
		"<command-name>/pstack:poteto-mode</command-name>\n"+
		"<command-args>现在 claude code 任务开始执行的时候, pairfob 列表页好像不展示标题了</command-args>", nil))
	want := Title{Prompt: "现在 claude code 任务开始执行的时候, pairfob 列表页好像不展示标题了"}
	if got := r.ReadTitle(ref); got != want {
		t.Fatalf("title=%+v", got)
	}
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "自动任务名"})
	now = now.Add(3 * time.Second)
	if got := r.ReadTitle(ref); got.Name != "自动任务名" || got.Prompt != want.Prompt {
		t.Fatalf("named=%+v", got)
	}
}

func TestClaudeTitleSlashCommandNestedRequest(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	// A command that forwards to another command: the nested name is the
	// carrier, the text after it is the request.
	appendClaudeTitleRecord(t, path, claudeUser("<command-name>/goal</command-name>\n"+
		"<command-message>goal</command-message>\n"+
		"<command-args>/poteto-mode 基于 https://github.com/longbridge/nsh 做原生的移动端版本</command-args>", nil))
	want := Title{Prompt: "基于 https://github.com/longbridge/nsh 做原生的移动端版本"}
	if got := r.ReadTitle(ref); got != want {
		t.Fatalf("title=%+v", got)
	}
}

func TestClaudeTitleSlashCommandWithoutArgsStaysEmpty(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	appendClaudeTitleRecord(t, path, claudeUser("<command-name>/clear</command-name>\n<command-args></command-args>", nil))
	if got := r.ReadTitle(ref); got != (Title{}) {
		t.Fatalf("title=%+v", got)
	}
}

func TestClaudeTitleRefreshesNativeNameAndPrefersCustomName(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	now := time.Unix(100, 0)
	r.now = func() time.Time { return now }
	appendClaudeTitleRecord(t, path, claudeUser("First request", nil))
	if got := r.ReadTitle(ref); got != (Title{Prompt: "First request"}) {
		t.Fatalf("initial=%+v", got)
	}
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "自动任务名"})
	if got := r.ReadTitle(ref); got.Name != "" {
		t.Fatal("cache did not bound repeated reads")
	}
	now = now.Add(3 * time.Second)
	if got := r.ReadTitle(ref); got.Name != "自动任务名" || got.Prompt != "First request" {
		t.Fatalf("generated=%+v", got)
	}
	appendClaudeTitleRecord(t, path, map[string]string{"type": "custom-title", "sessionId": ref.Value, "customTitle": "我的任务"})
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "Updated automatic title"})
	now = now.Add(3 * time.Second)
	if got := r.ReadTitle(ref); got.Name != "我的任务" {
		t.Fatalf("custom=%+v", got)
	}
	appendClaudeTitleRecord(t, path, map[string]string{"type": "custom-title", "sessionId": ref.Value, "customTitle": ""})
	now = now.Add(3 * time.Second)
	if got := r.ReadTitle(ref); got.Name != "Updated automatic title" {
		t.Fatalf("cleared=%+v", got)
	}
}

func TestClaudeTitleRejectsOtherBindingsAndUnsafeFiles(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": "other_session", "aiTitle": "Wrong session"})
	appendClaudeTitleRecord(t, path, map[string]string{"type": "custom-title", "customTitle": "No session"})
	appendClaudeTitleRecord(t, path, map[string]any{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "Sidechain", "isSidechain": true})
	if got := r.ReadTitle(ref); got != (Title{}) {
		t.Fatalf("untrusted metadata=%+v", got)
	}
	for _, invalid := range []Ref{
		{Agent: ref.Agent, Kind: ref.Kind, Value: ref.Value},
		{Source: ref.Source, Agent: ref.Agent, Kind: "path", Value: path},
		{Source: ref.Source, Agent: ref.Agent, Kind: ref.Kind, Value: "../escape"},
	} {
		if got := r.ReadTitle(invalid); got != (Title{}) {
			t.Fatalf("untrusted binding=%+v", got)
		}
	}
	outside := filepath.Join(t.TempDir(), "private.jsonl")
	if err := os.Rename(path, outside); err != nil {
		t.Fatal(err)
	}
	appendClaudeTitleRecord(t, outside, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "Private"})
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if got := (&Reader{ClaudeRoot: r.ClaudeRoot}).ReadTitle(ref); got != (Title{}) {
		t.Fatalf("symlink=%+v", got)
	}
}

func TestClaudeTitleReadsLatestMetadataAfterLargeToolOutput(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	appendClaudeTitleRecord(t, path, claudeUser("Original request", nil))
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "Old title"})
	appendClaudeTitleRecord(t, path, map[string]string{"type": "tool-output", "text": strings.Repeat("x", 2*titleReadBytes)})
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "Latest title"})
	// A valid-looking record without its final newline is still being written.
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString(`{"type":"ai-title","sessionId":"claude_title_session","aiTitle":"Incomplete"}`)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if got := r.ReadTitle(ref); got != (Title{Name: "Latest title", Prompt: "Original request"}) {
		t.Fatalf("large transcript=%+v", got)
	}
}

func TestLocalTranscriptsClaudeTitle(t *testing.T) {
	if os.Getenv("PAIRFOB_SCAN_LOCAL_TRANSCRIPTS") != "1" {
		t.Skip("requires an explicit local transcript scan")
	}
	r := NewDefault()
	files, _ := filepath.Glob(filepath.Join(r.ClaudeRoot, "projects", "*", "*.jsonl"))
	named, prompted := 0, 0
	for _, path := range files {
		ref := Ref{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: strings.TrimSuffix(filepath.Base(path), ".jsonl")}
		title := r.ReadTitle(ref)
		if title.Name != "" {
			named++
		}
		if title.Prompt != "" {
			prompted++
		}
		if strings.Contains(title.Prompt, ".pairfob/attachments/") || injectedLooking.MatchString(title.Prompt) {
			t.Errorf("%s: title contains injected context or attachment path", filepath.Base(path))
		}
	}
	t.Logf("claude: %d transcripts, %d native names, %d request excerpts", len(files), named, prompted)
}
