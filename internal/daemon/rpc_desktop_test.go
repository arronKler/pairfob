package daemon

import (
	"context"
	"encoding/json"
	"pairfob/internal/remotedesktop"
	"pairfob/internal/runtime"
	"sync/atomic"
	"testing"
	"time"
)

type testDesktop struct {
	allow atomic.Bool
	count atomic.Int32
	done  chan struct{}
}

func (h *testDesktop) Policy() remotedesktop.Policy {
	return remotedesktop.Policy{View: h.allow.Load(), Control: true}
}
func (h *testDesktop) Open(ctx context.Context, _ string, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	go func() { <-ctx.Done(); close(h.done) }()
	return h, remotedesktop.Result{SDP: "answer", Display: "screen", Control: r.Control}, nil
}
func (h *testDesktop) Input(remotedesktop.Event) error { h.count.Add(1); return nil }
func (h *testDesktop) Observe(observe, keyframe bool) remotedesktop.StreamObservation {
	return remotedesktop.StreamObservation{RTPTime: 420, Healthy: observe && keyframe, EncodeMS: 2.5}
}
func (h *testDesktop) Done() <-chan struct{} { return h.done }

func TestDesktopRequiresOwnerDirectLease(t *testing.T) {
	for _, control := range []bool{true, false} {
		h := &testDesktop{done: make(chan struct{})}
		h.allow.Store(true)
		e, c := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) { e.Desktop = h; e.Direct = &blockingDirectAcceptor{} })
		const id = "op_AAECAwQFBgcICQoL"
		req := remotedesktop.Request{OperationID: id, SDP: "offer", Quality: "motion", Control: control}
		if _, err := c.RPC("DesktopOpen", req); err == nil || err.Error() != "forbidden" {
			t.Fatalf("relay: %v", err)
		}
		markPhoneSessionP2P(t, e, c)
		if _, err := c.RPC("DesktopOpen", req); err != nil {
			t.Fatal(err)
		}
		if _, err := c.RPC("DesktopOpen", req); err == nil {
			t.Fatal("occupied slot accepted")
		}
		if _, err := c.RPC("DesktopPing", map[string]string{"desktop_id": "op_wrongdesktop12345678"}); err == nil {
			t.Fatal("wrong desktop accepted")
		}
		if _, err := c.RPC("DesktopPing", map[string]any{"desktop_id": id, "keyframe": true}); err == nil {
			t.Fatal("requested recovery without observation")
		}
		raw, err := c.RPC("DesktopPing", map[string]any{"desktop_id": id, "observe": true, "keyframe": true})
		var status remotedesktop.StreamObservation
		if err != nil || json.Unmarshal(raw, &status) != nil || !status.Healthy || status.RTPTime != 420 {
			t.Fatalf("direct status: %s, %v", raw, err)
		}
		in := map[string]any{"desktop_id": id, "operation_id": id + "_1", "sequence": 1, "event": map[string]string{"kind": "text", "text": "hello"}}
		_, err = c.RPC("DesktopInput", in)
		if (err == nil) != control {
			t.Fatalf("control %v: %v", control, err)
		}
		if _, err = c.RPC("DesktopInput", in); err == nil {
			t.Fatal("duplicate applied")
		}
		if control && h.count.Load() != 1 || !control && h.count.Load() != 0 {
			t.Fatal("input count")
		}
		if control {
			h.allow.Store(false)
		} else {
			e.mu.Lock()
			route := e.byDevice[c.DeviceID]
			e.mu.Unlock()
			e.closeSession(route, "disconnected", false)
		}
		select {
		case <-h.done:
		case <-time.After(2 * time.Second):
			t.Fatal("revocation did not close stream")
		}
	}
}

// Each media stream belongs to a fresh remote session, but both use the same local grant.
type reconnectDesktopHost struct{ grant atomic.Value }

func (h *reconnectDesktopHost) Policy() remotedesktop.Policy {
	return remotedesktop.Policy{View: true, Control: true, GrantID: h.grant.Load().(string)}
}
func (h *reconnectDesktopHost) Open(ctx context.Context, device string, r remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	stream := &testDesktop{done: make(chan struct{})}
	return stream.Open(ctx, device, r)
}

func TestDesktopReconnectUsesStandingGrant(t *testing.T) {
	h := &reconnectDesktopHost{}
	h.grant.Store("first")
	e, c := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) { e.Desktop = h; e.Direct = &blockingDirectAcceptor{} })
	markPhoneSessionP2P(t, e, c)
	for i, id := range []string{"op_AAECAwQFBgcICQoL", "op_BBECAwQFBgcICQoL"} {
		if _, err := c.RPC("DesktopOpen", remotedesktop.Request{OperationID: id, Quality: "balanced", SDP: "offer", Control: true}); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			// A delayed close for the retired ID acknowledges only that old stream.
			if _, err := c.RPC("DesktopClose", map[string]string{"desktop_id": "op_AAECAwQFBgcICQoL", "operation_id": "op_DDECAwQFBgcICQoL"}); err != nil {
				t.Fatal(err)
			}
			if _, err := c.RPC("DesktopPing", map[string]string{"desktop_id": id}); err != nil {
				t.Fatal(err)
			}
			h.grant.Store("replacement")
			if _, err := c.RPC("DesktopPing", map[string]string{"desktop_id": id}); err == nil {
				t.Fatal("previous grant survived replacement")
			}
			return
		}
		if _, err := c.RPC("DesktopClose", map[string]string{"desktop_id": id, "operation_id": "op_CCECAwQFBgcICQoL"}); err != nil {
			t.Fatal(err)
		}

	}
}

type policyDesktopHost struct{ policy remotedesktop.Policy }

func (h policyDesktopHost) Policy() remotedesktop.Policy { return h.policy }
func (h policyDesktopHost) Open(context.Context, string, remotedesktop.Request) (remotedesktop.Stream, remotedesktop.Result, error) {
	return nil, remotedesktop.Result{}, remotedesktop.ErrUnavailable
}

func TestGetConfigAdvertisesSetupDesktopCapability(t *testing.T) {
	tests := []struct {
		name        string
		desktop     remotedesktop.Host
		direct      bool
		wantSetup   bool
		wantView    bool
		wantControl bool
		wantAudio   bool
	}{
		{name: "no desktop host", desktop: nil, direct: true},
		{name: "direct disabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true, View: true, Control: true}}, direct: false},
		{name: "unsupported OS", desktop: policyDesktopHost{remotedesktop.Policy{Supported: false}}, direct: true},
		{name: "supported OS not enabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true}}, direct: true, wantSetup: true},
		{name: "supported OS view enabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true, View: true}}, direct: true, wantSetup: true, wantView: true, wantAudio: true},
		{name: "supported OS control enabled", desktop: policyDesktopHost{remotedesktop.Policy{Supported: true, View: true, Control: true}}, direct: true, wantSetup: true, wantView: true, wantControl: true, wantAudio: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, client := runtimeRPCClientWith(t, runtime.NewFake(), func(e *Engine) {
				e.Desktop = tc.desktop
				if tc.direct {
					e.Direct = &blockingDirectAcceptor{}
				}
			})
			raw, err := client.RPC("GetConfig", map[string]any{})
			if err != nil {
				t.Fatal(err)
			}
			caps := decodeResult(t, raw)["capabilities"].(map[string]any)
			if caps["setup_desktop"] != tc.wantSetup ||
				caps["view_desktop"] != tc.wantView ||
				caps["control_desktop"] != tc.wantControl ||
				caps["listen_desktop_audio"] != tc.wantAudio {
				t.Fatalf("desktop capabilities = %v, want setup=%v view=%v control=%v audio=%v",
					caps, tc.wantSetup, tc.wantView, tc.wantControl, tc.wantAudio)
			}
		})
	}
}
