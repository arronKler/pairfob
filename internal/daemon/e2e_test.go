package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/phone"
	"pairfob/internal/runtime"
)

func pump(t *testing.T, p *mux.Pipe, handle func(envelope.Frame)) chan struct{} {
	t.Helper()
	stop := make(chan struct{})
	go func() {
		for {
			f, ok := p.RecvTimeout(50 * time.Millisecond)
			select {
			case <-stop:
				return
			default:
			}
			if !ok {
				continue
			}
			handle(f)
		}
	}()
	return stop
}

func setup(t *testing.T) (*Engine, *mux.Hub, *mux.Pipe, *mux.Pipe, chan struct{}, chan struct{}) {
	t.Helper()
	hub := mux.NewHub("pf_test")
	engA, hubD := mux.NewPipePair(32)
	eng := NewEngine(hub, engA, runtime.NewFake())
	eng.AutoAdmit = true
	stopD := pump(t, hubD, func(f envelope.Frame) { hub.HandleDaemon(hubD, f) })
	if err := eng.Register("pf_test"); err != nil {
		t.Fatal(err)
	}
	stopE := make(chan struct{})
	go eng.RecvLoop(stopE)
	return eng, hub, hubD, engA, stopD, stopE
}

func TestPairingPingAndUnpaired(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	code := "7K3M9H2P"
	offer, err := eng.OpenPairing(code)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if len(offer.Ref) != 32 || len(offer.Code) != 8 {
		t.Fatal("invalid pairing offer")
	}

	phA, hubC := mux.NewPipePair(32)
	stopC := pump(t, hubC, func(f envelope.Frame) { hub.HandleClient(hubC, f) })
	defer close(stopC)
	ph := &phone.Client{Conn: phA}
	if err := ph.Pair("", code, ""); err != nil {
		t.Fatal("pair", err)
	}
	time.Sleep(50 * time.Millisecond)
	if !eng.HasDevice(ph.DeviceID) {
		t.Fatal("device not persisted")
	}

	// new SessionWS
	ph2a, hubC2 := mux.NewPipePair(32)
	stopC2 := pump(t, hubC2, func(f envelope.Frame) { hub.HandleClient(hubC2, f) })
	defer close(stopC2)
	ph2 := &phone.Client{Conn: ph2a, DeviceID: ph.DeviceID, PSK: ph.PSK, DaemonPK: ph.DaemonPK}
	if err := ph2.Resume(eng.DaemonID); err != nil {
		t.Fatal("resume", err)
	}
	time.Sleep(30 * time.Millisecond)
	raw, err := ph2.RPC("Ping", map[string]any{"t_ms": 42})
	if err != nil {
		t.Fatal("ping", err)
	}
	var pong struct {
		TEcho int64 `json:"t_echo_ms"`
	}
	_ = json.Unmarshal(raw, &pong)
	if pong.TEcho != 42 {
		t.Fatalf("pong %+v", pong)
	}

	snap, err := ph2.RPC("Snapshot", map[string]any{"session": nil})
	if err != nil {
		t.Fatal("snapshot", err)
	}
	if !strings.Contains(string(snap), `"blocked"`) {
		t.Fatalf("snapshot %s", snap)
	}

	// unpaired: new session without DeviceHello cannot Snapshot — send FWD plaintext Snapshot
	ph3a, hubC3 := mux.NewPipePair(32)
	stopC3 := pump(t, hubC3, func(f envelope.Frame) { hub.HandleClient(hubC3, f) })
	defer close(stopC3)
	_ = ph3a.Send(envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	_ = ph3a.Send(envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": eng.DaemonID}))
	f, ok := ph3a.RecvTimeout(time.Second)
	if !ok || f.Typ != envelope.TypSESSION_BOUND {
		t.Fatalf("bound %v %d", ok, f.Typ)
	}
	_ = ph3a.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: f.RouteID, Payload: []byte(`{"v":1,"id":"x","op":"Snapshot","params":{}}`)})
	// daemon should ignore (not established) — no AEAD reply. Ensure we don't get a snapshot result.
	f2, ok := ph3a.RecvTimeout(200 * time.Millisecond)
	if ok && f2.Typ == envelope.TypFWD {
		var helloErr struct {
			Op    string `json:"op"`
			OK    bool   `json:"ok"`
			Error *struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(f2.Payload, &helloErr) != nil || helloErr.Op != "DeviceHello2" || helloErr.OK || helloErr.Error == nil || helloErr.Error.Code != "unpaired" {
			t.Fatalf("unpaired snapshot leaked or wrong error: %s", f2.Payload)
		}
	}
}

func TestGuardedSendAndStalePrompt(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)
	code := "ABCDEFGH"
	offer, err := eng.OpenPairing(code)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	phA, hubC := mux.NewPipePair(32)
	stopC := pump(t, hubC, func(f envelope.Frame) { hub.HandleClient(hubC, f) })
	defer close(stopC)
	ph := &phone.Client{Conn: phA}
	if err := ph.Pair(offer.Ref, code, eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	ph2a, hubC2 := mux.NewPipePair(32)
	stopC2 := pump(t, hubC2, func(f envelope.Frame) { hub.HandleClient(hubC2, f) })
	defer close(stopC2)
	ph2 := &phone.Client{Conn: ph2a, DeviceID: ph.DeviceID, PSK: ph.PSK, DaemonPK: ph.DaemonPK}
	if err := ph2.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, err := ph2.RPC("SendText", map[string]any{"operation_id": "op_AAECAwQFBgcICQoL", "pane_id": "w0:p1", "text": "hello-pairfob", "submit": false}); err != nil {
		t.Fatal(err)
	}
	read, err := ph2.RPC("PaneRead", map[string]any{"pane_id": "w0:p1", "source": "visible", "format": "text", "lines": guardedPaneReadLines})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(read), "hello-pairfob") {
		t.Fatalf("readback %s", read)
	}
	var confirmed struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(read, &confirmed); err != nil || len(confirmed.Hash) != 64 {
		t.Fatalf("invalid read hash %q: %v", confirmed.Hash, err)
	}
	_, err = ph2.RPC("SendKeys", map[string]any{
		"operation_id": "op_AQECAwQFBgcICQoL", "pane_id": "w0:p1", "keys": []string{"Enter"},
		"intent": "submit", "expected_prompt": "❯", "expected_signature": strings.Repeat("0", 64),
	})
	if err == nil || err.Error() != "stale_prompt" {
		t.Fatalf("want signature stale_prompt got %v", err)
	}
	if _, err := ph2.RPC("SendKeys", map[string]any{
		"operation_id": "op_AgECAwQFBgcICQoL", "pane_id": "w0:p1", "keys": []string{"Enter"},
		"intent": "submit", "expected_prompt": "❯", "expected_signature": confirmed.Hash,
	}); err != nil {
		t.Fatal("enter", err)
	}
	_, err = ph2.RPC("SendKeys", map[string]any{"operation_id": "op_AwECAwQFBgcICQoL", "pane_id": "w0:p1", "keys": []string{"Enter"}, "intent": "dialog", "expected_prompt": "THIS_IS_NOT_ON_SCREEN"})
	if err == nil || err.Error() != "stale_prompt" {
		t.Fatalf("want stale_prompt got %v", err)
	}
	_, err = ph2.RPC("PaneRead", map[string]any{"pane_id": "w0:p1", "source": "recent", "format": "text", "lines": 400})
	if err == nil {
		t.Fatal("recent should be forbidden")
	}
}

func seedClient(t *testing.T, eng *Engine, hub *mux.Hub) *phone.Client {
	t.Helper()
	psk := make([]byte, 32)
	_, _ = rand.Read(psk)
	id := "dev_" + hex.EncodeToString(psk[:8])
	eng.PutDevice(id, psk)
	a, hc := mux.NewPipePair(32)
	pump(t, hc, func(f envelope.Frame) { hub.HandleClient(hc, f) })
	return &phone.Client{Conn: a, DeviceID: id, PSK: psk, DaemonPK: eng.PK}
}

func TestKickAndTooMany(t *testing.T) {
	eng, hub, _, _, stopD, stopE := setup(t)
	defer close(stopD)
	defer close(stopE)

	c1 := seedClient(t, eng, hub)
	if err := c1.Resume(eng.DaemonID); err != nil {
		t.Fatal(err)
	}
	a, hc := mux.NewPipePair(32)
	pump(t, hc, func(f envelope.Frame) { hub.HandleClient(hc, f) })
	c2 := &phone.Client{Conn: a, DeviceID: c1.DeviceID, PSK: c1.PSK, DaemonPK: c1.DaemonPK}
	if err := c2.Resume(eng.DaemonID); err != nil {
		t.Fatal("same-device resume", err)
	}
	fr, ok := c1.Conn.(*mux.Pipe).RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypERROR {
		t.Fatalf("want kicked on old bind ok=%v typ=%d", ok, fr.Typ)
	}
	var body envelope.ErrorBody
	_ = json.Unmarshal(fr.Payload, &body)
	if body.Code != "kicked" {
		t.Fatalf("want kicked got %+v", body)
	}
	if _, err := c2.RPC("Ping", map[string]any{"t_ms": 1}); err != nil {
		t.Fatal("c2 ping", err)
	}

	for i := 0; i < 9; i++ {
		cl := seedClient(t, eng, hub)
		if err := cl.Resume(eng.DaemonID); err != nil {
			t.Fatalf("device %d: %v", i+2, err)
		}
	}
	if _, err := c2.RPC("Ping", map[string]any{"t_ms": 2}); err != nil {
		t.Fatal("still-established ping", err)
	}

	eleventh := seedClient(t, eng, hub)
	err := eleventh.Resume(eng.DaemonID)
	if err == nil || err.Error() != "too_many_devices" {
		t.Fatalf("11th want too_many_devices got %v", err)
	}
	eng.mu.Lock()
	nEst := 0
	for _, s := range eng.sessions {
		if s.state == "established" {
			nEst++
		}
	}
	eng.mu.Unlock()
	if nEst != 10 {
		t.Fatalf("established %d want 10", nEst)
	}
}
