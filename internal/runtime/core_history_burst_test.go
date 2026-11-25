package runtime

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

func TestCoreThousandLineHistoryBurst(t *testing.T) {
	history := []byte(strings.Repeat(strings.Repeat("\x1b[31mA\x1b[32mB", 80)+"\r\n", 1000))
	conn, log, err := startCoreScript(t, coreScriptHello(), func(req coreScriptRequest) coreScriptReply {
		if req.method != "terminal.attach" {
			return coreScriptReply{result: map[string]any{"ok": true}}
		}
		var pushes []coreScriptPush
		for start := 0; start < len(history); start += 16 * 1024 {
			end := min(start+16*1024, len(history))
			pushes = append(pushes, coreScriptPush{channel: 7, data: history[start:end]})
		}
		return coreScriptReply{result: map[string]any{"channel": 7, "terminal": map[string]any{"address": "t3", "state": "live", "cols": 160, "rows": 24}}, push: pushes}
	})
	if err != nil {
		t.Fatal(err)
	}
	core := NewCore("")
	core.dial = func(context.Context) (coreTransport, coreHello, error) { return conn, conn.Hello(), nil }
	t.Cleanup(func() { _ = core.Close() })
	viewer, err := core.OpenTerminal(context.Background(), TerminalOpen{PaneID: encodeCoreAddress("t3"), Cols: 160, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	var got []byte
	deadline := time.After(3 * time.Second)
	for len(got) < len(history) {
		select {
		case event, ok := <-viewer.Events():
			if !ok || event.Closed != nil {
				t.Fatalf("history replay closed after %d/%d bytes", len(got), len(history))
			}
			if event.Frame != nil {
				got = append(got, event.Frame.Data...)
			}
			time.Sleep(time.Millisecond)
		case <-deadline:
			t.Fatalf("history stalled at %d/%d", len(got), len(history))
		}
	}
	if !bytes.Equal(got, history) {
		t.Fatal("history bytes changed or reordered")
	}
	if err := viewer.Input([]byte("after-history")); err != nil {
		t.Fatal(err)
	}
	waitForCore(t, func() bool { return log.hasFrame(7, coreKindData) })
}
