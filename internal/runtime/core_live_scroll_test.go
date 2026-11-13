package runtime

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

// Run only on the explicitly named scratch core used by the other live tests.
// The fixture prints before attach, then reads an SGR wheel report as raw input.
func TestCoreLiveHistoryAndWheelInput(t *testing.T) {
	coreLiveGated(t, true)
	core := NewCore("")
	t.Cleanup(func() { _ = core.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, _, err := core.connection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	script := `stty raw -echo; i=0; while [ "$i" -lt 150 ]; do printf 'history_%03d\r\n' "$i"; i=$((i+1)); done; printf 'wheel_ready\r\n'; dd bs=1 count=10 2>/dev/null | od -An -tx1; printf '\r\nwheel_received\r\n'; cat >/dev/null`
	var run coreRunResult
	if err := conn.Call(ctx, "terminal.run", map[string]any{
		"argv": []string{"/bin/sh", "-c", script}, "no_parent": true,
		"size": map[string]int{"cols": 80, "rows": 24},
	}, &run); err != nil {
		t.Fatalf("run fixture: %v", err)
	}
	paneID := encodeCoreAddress(run.Address)
	defer coreLiveClose(t, core, paneID)

	// Wait until output is in core's history before attaching a viewer.
	for {
		var read coreReadResult
		if err := conn.Call(ctx, "terminal.read", map[string]any{"terminal": run.Address}, &read); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(read.Text, "wheel_ready") {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("fixture did not become ready")
		case <-time.After(20 * time.Millisecond):
		}
	}
	viewer, err := core.OpenTerminal(ctx, TerminalOpen{PaneID: paneID, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = viewer.Close() }()
	var replay []byte
	for !bytes.Contains(replay, []byte("wheel_ready")) {
		replay = append(replay, liveScrollFrame(t, ctx, viewer)...)
	}
	if !bytes.Contains(replay, []byte("history_000")) {
		t.Fatal("viewer attach lost output older than the visible screen")
	}
	if err := viewer.Input([]byte("\x1b[<64;1;1M")); err != nil {
		t.Fatalf("wheel input: %v", err)
	}
	var output []byte
	for !bytes.Contains(output, []byte("wheel_received")) {
		output = append(output, liveScrollFrame(t, ctx, viewer)...)
	}
	if !strings.Contains(strings.Join(strings.Fields(string(output)), " "), "1b 5b 3c 36 34 3b 31 3b 31 4d") {
		t.Fatalf("wheel bytes changed in transit: %q", output)
	}
	t.Logf("replayed %d bytes of pre-attach history; SGR wheel bytes arrived intact", len(replay))
}

func liveScrollFrame(t *testing.T, ctx context.Context, viewer TerminalController) []byte {
	t.Helper()
	select {
	case event, ok := <-viewer.Events():
		if !ok || event.Closed != nil || event.Frame == nil {
			t.Fatalf("viewer interrupted: %+v", event)
		}
		return event.Frame.Data
	case <-ctx.Done():
		t.Fatal("timed out waiting for terminal output")
		return nil
	}
}
