package journal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeNativeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func checkNativeObservation(t *testing.T, r *Reader, ref Ref, prompt, tool, state string) {
	t.Helper()
	if !r.Available(ref) {
		t.Fatal("unavailable")
	}
	if title := r.ReadTitle(ref); title.Prompt != prompt {
		t.Fatalf("title %+v", title)
	}
	page, err := r.Read(ref, nil, 50)
	if err != nil || len(page.Messages) == 0 || page.Messages[0].Text != prompt {
		t.Fatalf("history %+v %v", page, err)
	}
	snapshot, err := r.loadStore(ref, true)
	if err != nil || strings.Contains(string(snapshot.data), "hidden") {
		t.Fatalf("leaked context: %v", err)
	}
	activity, ok := r.ReadTurnActivity(ref, TurnDone)
	if !ok || activity.Name != tool || activity.State != state {
		t.Fatalf("activity %+v %v", activity, ok)
	}
	bad := ref
	bad.Source = "phone"
	if r.Available(bad) || r.ReadTitle(bad) != (Title{}) {
		t.Fatal("untrusted binding")
	}
	bad = ref
	bad.Value = "other-session"
	if r.Available(bad) {
		t.Fatal("cross-session read")
	}
}

func TestAmpNativeObservation(t *testing.T) {
	root := t.TempDir()
	r := &Reader{NativeRoots: map[string]string{"amp": root}}
	ref := Ref{Source: "herdr:amp", Agent: "amp", Kind: "id", Value: "T-native-01"}
	data := `{"id":"T-native-01","title":"Amp title","messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>hidden</system-reminder>Fix titles"}]},{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"Read","input":{"path":"main.ts"}}]},{"role":"user","content":[{"type":"tool_result","toolUseID":"c1","run":{"status":"done","result":{"output":"permission denied","exitCode":1}}}]}]}`
	path := filepath.Join(root, "threads", ref.Value+".json")
	writeNativeFixture(t, path, data)
	checkNativeObservation(t, r, ref, "Fix titles", "Read", "error")
	writeNativeFixture(t, path, strings.Replace(data, `"status":"done"`, `"status":"running"`, 1))
	if _, err := r.loadStore(ref, true); err != nil {
		t.Fatal(err)
	}
	checkNativeObservation(t, r, ref, "Fix titles", "Read", "running")

	writeNativeFixture(t, path, strings.Replace(data, `"id":"T-native-01"`, `"id":"T-another-01"`, 1))
	if _, err := r.loadStore(ref, true); err == nil {
		t.Fatal("wrong embedded id accepted")
	}
}

func TestDroidNativeObservation(t *testing.T) {
	root := t.TempDir()
	r := &Reader{NativeRoots: map[string]string{"droid": root}}
	ref := Ref{Source: "herdr:droid", Agent: "droid", Kind: "id", Value: "native-session"}
	data := `{"type":"session_start","id":"native-session","title":"Droid task"}
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>hidden</system-reminder>Fix titles"}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"main.ts"}}]}}
{"type":"message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"source","is_error":false}]}}
`
	writeNativeFixture(t, filepath.Join(root, "sessions", "project", ref.Value+".jsonl"), data)
	checkNativeObservation(t, r, ref, "Fix titles", "Read", "done")
	if _, _, err := parseDroidSession([]byte(data), "wrong-id"); err == nil {
		t.Fatal("wrong id accepted")
	}
}

func TestMakiNativeObservation(t *testing.T) {
	root := t.TempDir()
	r := &Reader{NativeRoots: map[string]string{"maki": root}}
	ref := Ref{Source: "herdr:maki", Agent: "maki", Kind: "id", Value: "native-session"}
	data := `{"t":"header","v":3,"id":"native-session"}
{"t":"msg","d":{"role":"user","kind":"context_update","content":[{"type":"text","text":"hidden"}]}}
{"t":"sub_msg","sub":"child","d":{"role":"user","content":[{"type":"text","text":"hidden"}]}}
{"t":"msg","d":{"role":"user","display_text":"Fix titles","content":[{"type":"text","text":"hidden expanded prompt"}]}}
{"t":"msg","d":{"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"Read","input":{"path":"main.ts"}}]}}
{"t":"msg","d":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"source","is_error":false}]}}
{"t":"meta","title":"Native Maki name"}
`
	writeNativeFixture(t, filepath.Join(root, "sessions", ref.Value+".jsonl"), data)
	checkNativeObservation(t, r, ref, "Fix titles", "Read", "done")
	if title := r.ReadTitle(ref); title.Name != "Native Maki name" {
		t.Fatal(title)
	}
	if _, _, err := parseMakiSession([]byte(strings.Replace(data, `"v":3`, `"v":4`, 1)), ref.Value); err == nil {
		t.Fatal("future format accepted")
	}
}

func TestKimiCodeNativeObservation(t *testing.T) {
	root := t.TempDir()
	r := &Reader{NativeRoots: map[string]string{"kimi": t.TempDir(), "kimi-code": root}}
	ref := Ref{Source: "herdr:kimi", Agent: "kimi", Kind: "id", Value: "native-session"}
	path := filepath.Join(root, "sessions", "wd_one", "session_"+ref.Value, "agents", "main", "wire.jsonl")
	data := `{"type":"metadata","protocol_version":"1.5"}
{"type":"profile.bind","agentId":"main","systemPrompt":"hidden"}
{"type":"turn.prompt","agentId":"main","origin":{"kind":"user"},"input":[{"type":"text","text":"Fix titles"}],"time":1767225600000}
{"type":"context.append_message","agentId":"main","message":{"role":"user","content":"hidden"}}
{"type":"turn.prompt","agentId":"child","origin":{"kind":"user"},"input":"hidden"}
{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","toolCallId":"c1","name":"Read","args":{"path":"main.ts"}}}
{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.result","toolCallId":"c1","result":{"output":"missing","error":"not found"}}}
`
	writeNativeFixture(t, path, data)
	state := kimiStatePath(path)
	writeNativeFixture(t, state, `{"id":"session_native-session","version":2,"title":"Kimi title"}`)
	checkNativeObservation(t, r, ref, "Fix titles", "Read", "error")
	writeNativeFixture(t, state, `{"id":"session_native-session","version":2,"title":"Updated title"}`)
	r.now = func() time.Time { return time.Now().Add(3 * time.Second) }
	if title := r.ReadTitle(ref); title.Name != "Updated title" {
		t.Fatal(title)
	}
	writeNativeFixture(t, state, `{"id":"session_native-session","version":2,"title":"Updated title","custom_title":"My name"}`)
	r.now = func() time.Time { return time.Now().Add(6 * time.Second) }
	if title := r.ReadTitle(ref); title.Name != "My name" {
		t.Fatal(title)
	}
	writeNativeFixture(t, state, `{"id":"session_other-session","version":2}`)
	if _, err := r.loadStore(ref, true); err == nil {
		t.Fatal("state mismatch accepted")
	}
}
