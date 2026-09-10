package daemon

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"pairfob/internal/workspace"
)

// drain the disk or net bucket for the established session so the next read must
// sleep through quota admission.
func depleteMediaBuckets(t *testing.T, e *Engine, route [16]byte, net bool) (*sess, *mediaWindow, *mediaWindow) {
	t.Helper()
	e.mu.Lock()
	s := e.sessions[route]
	e.mu.Unlock()
	if s == nil {
		t.Fatal("no established session")
	}
	b := &e.media.bandwidth
	now := time.Now()
	b.mu.Lock()
	b.now = func() time.Time { return now }
	sess := b.session[s]
	if sess == nil {
		b.mu.Unlock()
		t.Fatal("no bound media quota")
	}
	var w, global *mediaWindow
	if net {
		w, global = &sess.net, &b.netGlobal
	} else {
		w, global = &sess.disk, &b.diskGlobal
	}
	w.tokens = 0
	w.last = now
	global.tokens = 0
	global.last = now
	b.mu.Unlock()
	return s, w, global
}

// D1: authority is revalidated after each asynchronous quota boundary.
func TestMediaRepairReadRevalidatesAfterQuotaWait(t *testing.T) {
	for _, kind := range []string{"same-owner", "cwd-during-disk", "pane-during-disk", "close-during-net"} {
		t.Run(kind, func(t *testing.T) {
			root, fake := workspaceRPCFixture(t)
			payload := make([]byte, workspace.MediaChunkBytes)
			if err := os.WriteFile(filepath.Join(root, "data.bin"), payload, 0o600); err != nil {
				t.Fatal(err)
			}
			e, c := runtimeRPCClient(t, fake)
			handle := openMedia(t, c, "data.bin")["handle"].(string)
			route := clientRoute(e, c)
			c.StartRPCMux()
			defer c.Conn.Close()
			defer e.closeSession(route, "", false)
			other := t.TempDir()

			_, w, global := depleteMediaBuckets(t, e, route, kind == "close-during-net")
			waited := false
			e.media.bandwidth.sleep = func(ctx context.Context, d time.Duration) error {
				if waited {
					t.Errorf("unexpected second quota wait")
					return context.DeadlineExceeded
				}
				waited = true
				switch kind {
				case "cwd-during-disk":
					fake.Snap.Panes[0].Cwd = other
					fake.Snap.Workspaces[0].Cwd = other
				case "pane-during-disk":
					fake.Snap.Panes = []runtime.Pane{}
				case "close-during-net":
					raw, err := c.MuxRPC("WorkspaceMediaClose", map[string]any{"handle": handle}, time.Second)
					if err != nil {
						t.Errorf("close RPC: %v", err)
						return err
					}
					if decodeResult(t, raw)["closed"] != true {
						t.Error("close did not complete")
					}
				}
				e.media.bandwidth.mu.Lock()
				w.tokens = w.burst
				global.tokens = global.burst
				e.media.bandwidth.mu.Unlock()
				return nil
			}

			raw, err := c.MuxRPC("WorkspaceMediaRead", map[string]any{
				"handle": handle, "offset": 0, "length": workspace.MediaChunkBytes,
			}, 5*time.Second)
			if !waited {
				t.Fatal("probe did not reach the intended quota boundary")
			}
			if kind == "same-owner" {
				if err != nil {
					t.Fatalf("same-owner read failed: %v", err)
				}
				if decodeResult(t, raw)["length"] != float64(len(payload)) {
					t.Fatal("same-owner read lost bytes")
				}
				return
			}
			if err == nil {
				var v struct {
					Length int `json:"length"`
				}
				_ = json.Unmarshal(raw, &v)
				t.Fatalf("stale %s Read published %d bytes after retirement", kind, v.Length)
			}
		})
	}
}

// D2: required offset and chunk range are validated with presence awareness and
// before any quota/disk work.
func TestMediaRepairReadRequiresPresentOffsetAndValidRange(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	mediaPNG(t, root, "data.bin", make([]byte, 1<<20))
	e, c := runtimeRPCClient(t, fake)
	defer e.closeSession(clientRoute(e, c), "", false)
	handle := openMedia(t, c, "data.bin")["handle"].(string)

	for _, name := range []string{"missing", "null", "explicit-zero"} {
		t.Run(name, func(t *testing.T) {
			p := map[string]any{"handle": handle, "length": 1}
			if name == "null" {
				p["offset"] = nil
			}
			if name == "explicit-zero" {
				p["offset"] = 0
			}
			_, err := c.RPC("WorkspaceMediaRead", p)
			if name == "explicit-zero" {
				if err != nil {
					t.Fatalf("legal offset=0 failed: %v", err)
				}
				return
			}
			if err == nil || err.Error() != "invalid_argument" {
				t.Fatalf("required non-null offset: got %v", err)
			}
		})
	}

	t.Run("oversized-length-rejected-before-quota", func(t *testing.T) {
		// Deplete the disk bucket: a length that reached quota would rate-limit,
		// but an over-large chunk must be invalid_argument first.
		_, _, _ = depleteMediaBuckets(t, e, clientRoute(e, c), false)
		_, err := c.RPC("WorkspaceMediaRead", map[string]any{
			"handle": handle, "offset": 0, "length": 1 << 20,
		})
		if err == nil || err.Error() != "invalid_argument" {
			t.Fatalf("invalid chunk length must fail before quota: got %v", err)
		}
	})

	t.Run("exact-eof-and-past-end", func(t *testing.T) {
		if _, err := c.RPC("WorkspaceMediaRead", map[string]any{
			"handle": handle, "offset": 1 << 20, "length": 1,
		}); err != nil {
			t.Fatalf("offset==size (EOF) should be legal: %v", err)
		}
		if _, err := c.RPC("WorkspaceMediaRead", map[string]any{
			"handle": handle, "offset": 1<<20 + 1, "length": 1,
		}); err == nil || err.Error() != "invalid_argument" {
			t.Fatalf("offset past end must be invalid_argument: got %v", err)
		}
	})
}

// D3: media ownership follows the immutable session epoch, not the mutable route.
func TestMediaRepairRetirementOwnsSessionPointer(t *testing.T) {
	t.Run("late-failed-epoch-keeps-replacement-media", func(t *testing.T) {
		e, old, _ := establishedSendSession(t, newFailNthConn(0))
		route := old.routeID
		replacement := &sess{
			routeID: route, deviceID: "dev_new", state: "established", transport: "p2p",
			link: newFailNthConn(0), s2c: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirServer},
		}
		e.mu.Lock()
		e.sessions[route] = replacement
		e.mu.Unlock()
		ctx, err := e.mediaLiveContext(replacement)
		if err != nil {
			t.Fatal(err)
		}
		defer e.closeSession(route, "", false)
		e.failTransportEpoch(old)
		if e.Session(route) != replacement {
			t.Fatal("control: session pointer was lost")
		}
		if ctx.Err() != nil || !e.media.bandwidth.sessionLive(replacement) {
			t.Fatalf("old epoch cleanup canceled current media: ctx=%v quotaLive=%v", ctx.Err(), e.media.bandwidth.sessionLive(replacement))
		}
	})

	t.Run("session-bound-drains-retired-media", func(t *testing.T) {
		e, old, _ := establishedSendSession(t, newFailNthConn(0))
		route := old.routeID
		ctx, err := e.mediaLiveContext(old)
		if err != nil {
			t.Fatal(err)
		}
		e.handleSessionBound(envelope.JSON(envelope.TypSESSION_BOUND, route, map[string]any{
			"v": e.muxVersion(), "route_id": hex.EncodeToString(route[:]),
		}))
		defer e.closeSession(route, "", false)
		if e.Session(route) == old || old.state != "closed" {
			t.Fatal("control: SESSION_BOUND did not replace old epoch")
		}
		if ctx.Err() == nil {
			t.Fatal("SESSION_BOUND left retired media context/quota live")
		}
		assertMediaRetirementDrained(t, e)
	})

	t.Run("p2p-commit-migrates-and-close-drains-media", func(t *testing.T) {
		relay, _ := mux.NewPipePair(16)
		direct, _ := mux.NewPipePair(16)
		e := NewEngine(nil, relay, runtime.NewFake())
		oldRoute, newRoute := [16]byte{3}, [16]byte{4}
		attempt := "p2p_0123456789abcdef"
		parent := &sess{
			routeID: oldRoute, deviceID: "dev_upgrade", state: "established", transport: "relay", link: relay,
			c2s: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirClient},
			s2c: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirServer},
		}
		candidate := &sess{
			routeID: newRoute, deviceID: parent.deviceID, state: "upgrade_ready", transport: "p2p", link: direct,
			upgradeFrom: oldRoute, attemptID: attempt,
			c2s: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirClient},
			s2c: &aead.Direction{Key: make([]byte, 32), Dir: aead.DirServer},
		}
		e.mu.Lock()
		e.sessions[oldRoute] = parent
		e.sessions[newRoute] = candidate
		e.byDevice[parent.deviceID] = oldRoute
		e.mu.Unlock()
		ctx, err := e.mediaLiveContext(parent)
		if err != nil {
			t.Fatal(err)
		}
		params, _ := json.Marshal(transportCommitParams{AttemptID: attempt, RouteID: hex.EncodeToString(newRoute[:])})
		e.rpcTransportCommit(parent, "req_commit", params)
		if parent.routeID != newRoute || parent.transport != "p2p" {
			t.Fatal("control: commit did not upgrade")
		}
		// The same owner's media survived the route migration.
		if ctx.Err() != nil || !e.media.bandwidth.sessionLive(parent) {
			t.Fatal("migration canceled the continuing session's media")
		}
		e.closeSession(newRoute, "", false)
		if ctx.Err() == nil {
			t.Error("P2P session close left its media context live")
		}
		assertMediaRetirementDrained(t, e)
	})
}
