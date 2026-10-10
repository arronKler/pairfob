package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

func TestWriterIdentifiesRealTerminals(t *testing.T) {
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { null.Close() })
	if writerIsTTY(null) {
		t.Fatal("/dev/null must not be treated as an interactive terminal")
	}
	file, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reader.Close(); writer.Close() })
	if writerIsTTY(file) || writerIsTTY(writer) || writerIsTTY(&bytes.Buffer{}) {
		t.Fatal("files, pipes and buffers must not be interactive")
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if writerIsTTY(file) {
		t.Fatal("a closed file must not be interactive")
	}
}

// Run with PAIRFOB_TEST_TTY=1 in a terminal to check an actual PTY slave.
func TestWriterRecognizesInteractiveStdout(t *testing.T) {
	if os.Getenv("PAIRFOB_TEST_TTY") != "1" {
		t.Skip("requires the test process's stdout to be attached to a terminal")
	}
	if !writerIsTTY(os.Stdout) || !stdoutIsTTY() {
		t.Fatal("a real terminal must be treated as interactive")
	}
}

func TestNullStdoutUsesForegroundStartup(t *testing.T) {
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { null.Close() })
	previous := os.Stdout
	os.Stdout = null
	t.Cleanup(func() { os.Stdout = previous })
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PAIRFOB_STATE_DIR", t.TempDir())
	sock := testSocket(t)
	t.Setenv("PAIRFOB_ADMIN_SOCK", sock)
	t.Setenv("PAIRFOB_DEV_FAKE_RUNTIME", "1")
	// Stop startup locally before enrollment; status mode never reaches this.
	t.Setenv("PAIRFOB_PROTOCOL", "invalid")
	err = runBareCommand(os.Stdout, sock, stdoutIsTTY())
	if err == nil || !strings.Contains(err.Error(), "PAIRFOB_PROTOCOL must be 2") {
		t.Fatalf("/dev/null stdout did not enter foreground startup: %v", err)
	}
}
