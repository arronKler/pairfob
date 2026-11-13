package journal

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClaudeTitlePrefilterPreservesJSONAndVisibility(t *testing.T) {
	cases := []struct{ line, want string }{
		{`{"type":"assistant","payload":{"type":"ai-title","aiTitle":"nested"}}`, ""},
		{`{"type":"assistant","type":"ai-title","sessionId":"s","aiTitle":"last"}`, "last"},
		{`{"type":"ai-title","type":"assistant","sessionId":"s","aiTitle":"first"}`, ""},
		{`{"type":"a\u0069-title","sessionId":"s","aiTitle":"escaped value"}`, "escaped value"},
		{`{"ty\u0070e":"ai-title","sessionId":"s","aiTitle":"escaped key"}`, "escaped key"},
		{`{"TYPE":"ai-title","sessionId":"s","aiTitle":"folded key"}`, "folded key"},
		{`{"type":"ai-title","sessionId":"other","aiTitle":"wrong"}`, ""},
		{`{"type":"ai-title","sessionId":"s","aiTitle":"hidden","isMeta":true}`, ""},
		{`{"type":"ai-title","sessionId":"s","aiTitle":"bad"} trailing`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.line, func(t *testing.T) {
			data := []byte(tc.line + "\n")
			var state claudeTitleState
			if err := state.read(bytes.NewReader(data), 0, int64(len(data)), "s", false); err != nil {
				t.Fatal(err)
			}
			if state.generated != tc.want {
				t.Fatalf("got %q, want %q", state.generated, tc.want)
			}
		})
	}
	data := []byte(`{"type":"\u0075ser","message":{"role":"user","content":"Escaped request"}}` + "\n")
	var state claudeTitleState
	if err := state.read(bytes.NewReader(data), 0, int64(len(data)), "s", true); err != nil {
		t.Fatal(err)
	}
	if state.prompt != "Escaped request" {
		t.Fatalf("escaped request lost: %q", state.prompt)
	}
}

func TestClaudeTitleFileCacheRefreshesChangedAndReplacedFiles(t *testing.T) {
	r, ref, path := claudeTitleFixture(t)
	now := time.Unix(100, 0)
	r.now = func() time.Time { return now }
	write := func(name string) {
		t.Helper()
		data := fmt.Sprintf("{\"type\":\"ai-title\",\"sessionId\":%q,\"aiTitle\":%q}\n", ref.Value, name)
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	read := func(want string) {
		t.Helper()
		now = now.Add(3 * time.Second)
		if got := r.ReadTitle(ref); got.Name != want {
			t.Fatalf("got %q want %q", got.Name, want)
		}
	}
	write("first")
	read("first")
	read("first") // Beyond the TTL, a verified unchanged file retains its result.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	write("other")
	if err := os.Chtimes(path, now, now); err != nil {
		t.Fatal(err)
	}
	read("other") // Same length, different mtime.
	info, err = os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	write("third")
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	read("third") // New inode, same size and original mtime.
	write("")
	read("")
	appendClaudeTitleRecord(t, path, map[string]string{"type": "ai-title", "sessionId": ref.Value, "aiTitle": "appended"})
	read("appended")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	// A cache hit must still verify the file and reject a symlink.
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	if err := os.WriteFile(outside, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.claudeTitle(ref); ok {
		t.Fatal("unsafe file accepted from cache")
	}
}

func BenchmarkClaudeTitleToolOutput(b *testing.B) {
	data := []byte(`{"type":"user","message":{"role":"user","content":"Original request"}}` + "\n" +
		strings.Repeat(`{"type":"assistant","message":{"content":[{"type":"text","text":"`+strings.Repeat("x", 8192)+`"}]}}`+"\n", 200) +
		`{"type":"custom-title","sessionId":"s","customTitle":"Latest title"}` + "\n")
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		var state claudeTitleState
		if err := state.read(bytes.NewReader(data), 0, int64(len(data)), "s", true); err != nil {
			b.Fatal(err)
		}
		if state.custom != "Latest title" || state.prompt != "Original request" {
			b.Fatal("lost title or request")
		}
	}
}
