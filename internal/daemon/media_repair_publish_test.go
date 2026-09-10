package daemon

import (
	goruntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"pairfob/internal/workspace"
)

// The final media reply waits at the interactive-priority send gate. A Close
// that completes during that wait retires the handle; after the gate releases
// the Read must publish an error, never the stale chunk bytes. The same-owner
// case still delivers its full chunk, and the priority gate must not deadlock
// (interactive Close keeps running while the media reply is parked).
func TestMediaRepairFinalSendWaitRevalidatesOwner(t *testing.T) {
	for _, retired := range []bool{false, true} {
		name := "same-owner"
		if retired {
			name = "close-completes-before-publish"
		}
		t.Run(name, func(t *testing.T) {
			root, fake := workspaceRPCFixture(t)
			payload := make([]byte, workspace.MediaChunkBytes)
			copy(payload, []byte("initial-owner-bytes"))
			mediaPNG(t, root, "bytes.bin", payload)
			e, c := runtimeRPCClient(t, fake)
			handle := openMedia(t, c, "bytes.bin")["handle"].(string)
			route := clientRoute(e, c)
			e.mu.Lock()
			owner := e.sessions[route]
			e.mu.Unlock()
			c.StartRPCMux()
			defer c.Conn.Close()
			defer e.closeSession(route, "", false)

			// Hold the interactive gate: a media (non-interactive) reply now spins
			// in lockSend until the gate drains.
			owner.interactiveWait.Add(1)
			var release sync.Once
			defer release.Do(func() { owner.interactiveWait.Add(-1) })

			type result struct {
				length int
				err    error
			}
			done := make(chan result, 1)
			go func() {
				raw, err := c.MuxRPC("WorkspaceMediaRead", map[string]any{
					"handle": handle, "offset": 0, "length": len(payload),
				}, 5*time.Second)
				if err != nil {
					done <- result{err: err}
					return
				}
				done <- result{length: int(decodeResult(t, raw)["length"].(float64))}
			}()

			// Wait until the Read is actually parked at the final lockSend gate.
			deadline := time.Now().Add(2 * time.Second)
			waiting := false
			for time.Now().Before(deadline) {
				stack := make([]byte, 1<<20)
				n := goruntime.Stack(stack, true)
				for _, g := range strings.Split(string(stack[:n]), "\n\n") {
					if strings.Contains(g, "(*sess).lockSend") && strings.Contains(g, "rpcWorkspaceMediaRead") {
						waiting = true
						break
					}
				}
				if waiting {
					break
				}
				goruntime.Gosched()
			}
			if !waiting {
				t.Fatal("read never reached the final lockSend wait")
			}
			select {
			case <-done:
				t.Fatal("read completed while the interactive gate was held")
			default:
			}

			if retired {
				// Interactive Close runs ahead of the parked media reply and removes
				// the handle before the gate drains.
				raw, err := c.MuxRPC("WorkspaceMediaClose", map[string]any{"handle": handle}, time.Second)
				if err != nil || decodeResult(t, raw)["closed"] != true {
					t.Fatalf("close did not complete: %s %v", raw, err)
				}
				e.media.mu.Lock()
				gone := e.media.byHandle[handle] == nil
				e.media.mu.Unlock()
				if !gone {
					t.Fatal("closed handle remains installed")
				}
			}

			release.Do(func() { owner.interactiveWait.Add(-1) })
			got := <-done

			if !retired {
				if got.err != nil || got.length != len(payload) {
					t.Fatalf("same-owner reply failed: length=%d err=%v", got.length, got.err)
				}
				return
			}
			if got.err == nil {
				t.Fatalf("retired handle published %d bytes after Close completed", got.length)
			}
		})
	}
}
