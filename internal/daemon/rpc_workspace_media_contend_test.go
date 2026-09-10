package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/workspace"
)

func TestWorkspaceMediaSameSessionTerminalNotStarved(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	payload := make([]byte, 1<<20)
	if err := os.WriteFile(filepath.Join(root, "clip.bin"), payload, 0o644); err != nil {
		t.Fatal(err)
	}
	engine, client := runtimeRPCClient(t, fake)
	handle := openMedia(t, client, "clip.bin")["handle"].(string)
	client.StartRPCMux()

	egress := make(chan struct{}, 8)
	engine.mediaSendHook = func(_ *sess, frame envelope.Frame) {
		if frame.Typ == envelope.TypFWD && len(frame.Payload) > 20_000 {
			select {
			case egress <- struct{}{}:
			default:
			}
			time.Sleep(40 * time.Millisecond)
		}
	}

	progress := make(chan int, 64)
	errCh := make(chan error, 1)
	go func() {
		offset := 0
		for offset < len(payload) {
			raw, err := client.MuxRPC("WorkspaceMediaRead", map[string]any{
				"handle": handle, "offset": offset, "length": workspace.MediaChunkBytes,
			}, 30*time.Second)
			if err != nil {
				errCh <- err
				return
			}
			var chunk map[string]any
			if err := json.Unmarshal(raw, &chunk); err != nil {
				errCh <- err
				return
			}
			n := int(chunk["length"].(float64))
			offset += n
			progress <- offset
		}
		errCh <- nil
	}()

	select {
	case <-egress:
	case <-time.After(5 * time.Second):
		t.Fatal("media egress did not start on this session")
	}
	start := time.Now()
	if _, err := client.MuxRPC("PaneRead", map[string]any{
		"pane_id": "w0:p1", "source": "visible", "format": "text", "lines": 20,
	}, 5*time.Second); err != nil {
		t.Fatalf("same-session pane read during media: %v", err)
	}
	latency := time.Since(start)
	t.Logf("same-session PaneRead overlapping in-flight media FWD took %s; transport=mux.Pipe with 40ms delay on FWD payloads >20KiB; shared sendMu; interactive replies run before the next media chunk", latency)
	if latency > 250*time.Millisecond {
		t.Fatalf("terminal read waited %s behind media chunks on the same session", latency)
	}
	before := 0
	select {
	case before = <-progress:
	case <-time.After(2 * time.Second):
		t.Fatal("no media progress after egress barrier")
	}
	deadline := time.After(15 * time.Second)
	after := before
	gotErr := false
	var transferErr error
	for after <= before {
		select {
		case after = <-progress:
		case transferErr = <-errCh:
			gotErr = true
			if transferErr != nil {
				t.Fatalf("media transfer: %v", transferErr)
			}
			after = len(payload)
		case <-deadline:
			t.Fatal("media did not continue after pane read")
		}
	}
	if !gotErr {
		if err := <-errCh; err != nil {
			t.Fatalf("media transfer: %v", err)
		}
	}
}
