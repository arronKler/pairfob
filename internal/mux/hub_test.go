package mux

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/envelope"
)

func TestPairRefOnOpen(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(8)
	stop := make(chan struct{})
	go func() {
		for {
			f, ok := dH.RecvTimeout(20 * time.Millisecond)
			select {
			case <-stop:
				return
			default:
			}
			if ok {
				h.HandleDaemon(dH, f)
			}
		}
	}()
	defer close(stop)
	_ = dA.Send(envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{"v": 1, "op": "RegisterDaemon", "join_token": "kt"}))
	f, ok := dA.RecvTimeout(time.Second)
	if !ok || f.Typ != envelope.TypHELLO_DAEMON {
		t.Fatal("register")
	}
	var resp struct {
		DaemonID string `json:"daemon_id"`
	}
	_ = json.Unmarshal(f.Payload, &resp)
	_ = dA.Send(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": resp.DaemonID, "pair_ref": "WRONG", "ttl_s": 180,
	}))
	f, ok = dA.RecvTimeout(time.Second)
	if !ok || f.Typ != envelope.TypERROR {
		t.Fatal("want bad_token")
	}
	ref := "4f7a2c9e1b0d88aa55cc3311abde7001"
	_ = dA.Send(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": resp.DaemonID, "pair_ref": ref, "ttl_s": 180,
	}))
}

func TestPairSlotRefreshExtendsTTL(t *testing.T) {
	h := NewHub("kt")
	now := time.Date(2026, 8, 24, 20, 0, 0, 0, time.UTC)
	var nowUnix atomic.Int64
	nowUnix.Store(now.Unix())
	h.now = func() time.Time { return time.Unix(nowUnix.Load(), 0) }
	dA, dH := NewPipePair(8)
	stop := make(chan struct{})
	go func() {
		for {
			f, ok := dH.RecvTimeout(20 * time.Millisecond)
			select {
			case <-stop:
				return
			default:
			}
			if ok {
				h.HandleDaemon(dH, f)
			}
		}
	}()
	defer close(stop)
	_ = dA.Send(envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, map[string]any{"v": 1, "op": "RegisterDaemon", "join_token": "kt"}))
	f, ok := dA.RecvTimeout(time.Second)
	if !ok {
		t.Fatal("reg")
	}
	var resp struct {
		DaemonID string `json:"daemon_id"`
	}
	_ = json.Unmarshal(f.Payload, &resp)
	ref := "4f7a2c9e1b0d88aa55cc3311abde7001"
	open := func() {
		_ = dA.Send(envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
			"v": 1, "op": "CreatePairing", "daemon_id": resp.DaemonID, "pair_ref": ref, "ttl_s": 180,
		}))
	}
	open()
	time.Sleep(20 * time.Millisecond)
	nowUnix.Add(int64(200 * time.Second / time.Second))
	attach := func() envelope.Frame {
		cA, cH := NewPipePair(8)
		go func() {
			for {
				fr, ok := cH.RecvTimeout(15 * time.Millisecond)
				if ok {
					h.HandleClient(cH, fr)
				}
			}
		}()
		_ = cA.Send(envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
		_ = cA.Send(envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
		fr, ok := cA.RecvTimeout(time.Second)
		if !ok {
			t.Fatal("no attach reply")
		}
		return fr
	}
	fr := attach()
	if fr.Typ != envelope.TypERROR {
		t.Fatalf("expired want unpaired got %d", fr.Typ)
	}
	nowUnix.Add(1)
	open()
	time.Sleep(20 * time.Millisecond)
	fr = attach()
	if fr.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("after refresh want PAIR_ATTACHED got %d %s", fr.Typ, fr.Payload)
	}
}

func TestGlobalPairingSlotLatestComputerWins(t *testing.T) {
	h := NewHub("kt")
	d1A, d1H := NewPipePair(16)
	d1, _, _ := registerTestDaemon(t, h, d1A, d1H)
	d2A, d2H := NewPipePair(16)
	d2, _, _ := registerTestDaemon(t, h, d2A, d2H)
	ref1 := "11111111111111111111111111111111"
	ref2 := "22222222222222222222222222222222"
	h.HandleDaemon(d1H, envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": d1, "pair_ref": ref1, "ttl_s": 180,
	}))
	h.HandleDaemon(d2H, envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": d2, "pair_ref": ref2, "ttl_s": 180,
	}))
	assertErrorCode(t, d1A, "pairing_replaced")

	staleA, staleH := NewPipePair(8)
	h.HandleClient(staleH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(staleH, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1, "pair_ref": ref1}))
	assertErrorCode(t, staleA, "unpaired")

	manualA, manualH := NewPipePair(8)
	h.HandleClient(manualH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(manualH, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
	attached, ok := manualA.RecvTimeout(time.Second)
	if !ok || attached.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("manual attach did not reach latest slot: ok=%v typ=%d", ok, attached.Typ)
	}
	var body struct {
		DaemonID string `json:"daemon_id"`
		PairRef  string `json:"pair_ref"`
	}
	if json.Unmarshal(attached.Payload, &body) != nil || body.DaemonID != d2 || body.PairRef != ref2 {
		t.Fatalf("manual attach selected wrong slot: %+v", body)
	}
}

func TestSilentManualAttachIsReclaimed(t *testing.T) {
	h := NewHub("kt")
	h.pairFirstFrame = 20 * time.Millisecond
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	ref := "33333333333333333333333333333333"
	h.HandleDaemon(dH, envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": daemonID, "pair_ref": ref, "ttl_s": 180,
	}))

	c1A, c1H := NewPipePair(8)
	h.HandleClient(c1H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c1H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
	if frame, ok := c1A.RecvTimeout(time.Second); !ok || frame.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatal("first manual attach failed")
	}
	assertErrorCode(t, c1A, "pair_timeout")

	c2A, c2H := NewPipePair(8)
	h.HandleClient(c2H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c2H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
	if frame, ok := c2A.RecvTimeout(time.Second); !ok || frame.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("slot was not reclaimed: ok=%v typ=%d", ok, frame.Typ)
	}
}

func TestPairingProofProgressTimeoutIsReclaimed(t *testing.T) {
	h := NewHub("kt")
	h.pairConfirmWait = 20 * time.Millisecond
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	ref := "44444444444444444444444444444444"
	h.HandleDaemon(dH, envelope.JSON(envelope.TypPAIR_OPEN, [16]byte{}, map[string]any{
		"v": 1, "op": "CreatePairing", "daemon_id": daemonID, "pair_ref": ref, "ttl_s": 180,
	}))

	c1A, c1H := NewPipePair(8)
	h.HandleClient(c1H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c1H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
	attached, ok := c1A.RecvTimeout(time.Second)
	if !ok || attached.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatal("first manual attach failed")
	}
	h.HandleClient(c1H, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: attached.RouteID, Payload: []byte(`{"v":1}`)})
	assertErrorCode(t, c1A, "pair_timeout")

	c2A, c2H := NewPipePair(8)
	h.HandleClient(c2H, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(c2H, envelope.JSON(envelope.TypPAIR_ATTACH, [16]byte{}, map[string]any{"v": 1}))
	if frame, ok := c2A.RecvTimeout(time.Second); !ok || frame.Typ != envelope.TypPAIR_ATTACHED {
		t.Fatalf("progress timeout did not release slot: ok=%v typ=%d", ok, frame.Typ)
	}
}
