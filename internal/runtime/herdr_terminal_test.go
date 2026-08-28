package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTerminalFixture(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "herdr-terminal-fixture")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nset -eu\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func waitForFileText(t *testing.T, path string, want ...string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(path)
		text := string(raw)
		matched := true
		for _, item := range want {
			matched = matched && strings.Contains(text, item)
		}
		if matched {
			return text
		}
		time.Sleep(10 * time.Millisecond)
	}
	raw, _ := os.ReadFile(path)
	t.Fatalf("terminal fixture log %q never contained %q", raw, want)
	return ""
}

func TestHerdrTerminalBridgesFramesAndCommands(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "commands.ndjson")
	t.Setenv("PAIRFOB_TERMINAL_TEST_LOG", logPath)
	binary := writeTerminalFixture(t, `
printf '%s\n' '{"type":"terminal.frame","seq":7,"encoding":"ansi","width":80,"height":24,"full":true,"bytes":"G1sySkhlbGxv"}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$PAIRFOB_TERMINAL_TEST_LOG"
  case "$line" in
    *terminal.input*) printf '%s\n' '{"type":"terminal.frame","seq":8,"encoding":"ansi","width":80,"height":24,"full":false,"bytes":"b2s="}' ;;
    *terminal.release*) exit 0 ;;
  esac
done
`)
	herdr := NewHerdr("/unused.sock")
	herdr.TerminalBinary = binary
	controller, err := herdr.OpenTerminal(context.Background(), TerminalOpen{
		Session: NamedSession("alpha"), PaneID: "w0:p1", Cols: 80, Rows: 24, Takeover: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	first := <-controller.Events()
	if first.Frame == nil || first.Frame.Sequence != 7 || !first.Frame.Full || string(first.Frame.Data) != "\x1b[2JHello" {
		t.Fatalf("initial frame = %+v", first.Frame)
	}
	if err := controller.Input([]byte("ok")); err != nil {
		t.Fatal(err)
	}
	second := <-controller.Events()
	if second.Frame == nil || second.Frame.Sequence != 8 || string(second.Frame.Data) != "ok" {
		t.Fatalf("incremental frame = %+v", second.Frame)
	}
	if err := controller.Resize(TerminalResize{Cols: 100, Rows: 30, CellWidthPX: 8, CellHeightPX: 16}); err != nil {
		t.Fatal(err)
	}
	if err := controller.Scroll(TerminalScroll{Direction: "up", Lines: 3, Source: "wheel"}); err != nil {
		t.Fatal(err)
	}
	written := waitForFileText(t, logPath, "terminal.input", "terminal.resize", "terminal.scroll")
	for _, fragment := range []string{`"bytes":"b2s="`, `"cols":100`, `"lines":3`, `"modifiers":0`} {
		if !strings.Contains(written, fragment) {
			t.Fatalf("command log missing %s: %s", fragment, written)
		}
	}
	if err := controller.Close(); err != nil {
		t.Fatal(err)
	}
	waitForFileText(t, logPath, "terminal.release")
}

func TestResolveHerdrBinaryFallsBackToHomeLocal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HERDR_BIN", "")
	dir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "herdr")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := resolveHerdrBinary("")
	if err != nil || got != path {
		t.Fatalf("got %q err=%v want %q", got, err, path)
	}
}

func TestHerdrTerminalRejectsInvalidFirstRecord(t *testing.T) {
	binary := writeTerminalFixture(t, `printf '%s\n' '{"type":"terminal.frame","seq":1,"encoding":"text","width":80,"height":24,"full":true,"bytes":""}'`)
	herdr := NewHerdr("/unused.sock")
	herdr.TerminalBinary = binary
	_, err := herdr.OpenTerminal(context.Background(), TerminalOpen{PaneID: "w0:p1", Cols: 80, Rows: 24})
	if err == nil || !strings.Contains(err.Error(), "metadata is invalid") {
		t.Fatalf("invalid first record error = %v", err)
	}
}
