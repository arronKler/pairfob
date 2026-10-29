package journal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLocalBindingReadsNativeTitleAndProgress(t *testing.T) {
	root := t.TempDir()
	id := "native-session-01"
	path := filepath.Join(root, "tmp", "project", "chats", "session-2026-01-01T00-00-native-s.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data := `{"sessionId":"native-session-01","summary":"Fix titles","messages":[{"id":"u","type":"user","content":"Show the correct session"},{"id":"a","type":"gemini","toolCalls":[{"id":"call-1","name":"Read","args":{"file_path":"main.go"},"status":"pending"}]}]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	r := &Reader{NativeRoots: map[string]string{"gemini": root, "amp": root, "cline": root, "maki": root, "qwen": root, "agy": root}}
	if !r.Supports(Ref{Source: "herdr:antigravity_cli", Agent: "agy", Kind: "id", Value: id}) {
		t.Fatal("native Antigravity source rejected")
	}
	ref := Ref{Source: "pairfob:gemini", Agent: "gemini", Kind: "id", Value: id}
	if !r.Available(ref) {
		t.Fatal("local runtime binding unavailable")
	}
	if title := r.ReadTitle(ref); title.Name != "Fix titles" || title.Prompt != "Show the correct session" {
		t.Fatalf("title: %+v", title)
	}
	if step, ok := r.ReadTurnActivity(ref, TurnWorking); !ok || step.Name != "Read" {
		t.Fatalf("step: %+v %v", step, ok)
	}
	for _, agent := range []string{"amp", "cline", "maki"} {
		if !r.Supports(Ref{Source: "pairfob:" + agent, Agent: agent, Kind: "id", Value: id}) {
			t.Fatal(agent)
		}
	}
	for _, bad := range []Ref{
		{Source: "pairfob:amp", Agent: "gemini", Kind: "id", Value: id},
		{Source: "pairfob:qwen", Agent: "qwen", Kind: "id", Value: id},
		{Source: "pairfob:gemini", Agent: "gemini", Kind: "path", Value: path},
		{Source: "pairfob:gemini", Agent: "gemini", Kind: "id", Value: "../../private"},
	} {
		if r.Supports(bad) {
			t.Fatalf("accepted untrusted binding %+v", bad)
		}
	}
}
