package mux

import (
	"encoding/json"
	"testing"
	"time"

	"pairfob/internal/envelope"
)

func TestEleventhEstablishedRejected(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(64)
	stop := make(chan struct{})
	go func() {
		for {
			f, ok := dH.RecvTimeout(15 * time.Millisecond)
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

	attach := func() (*Pipe, [16]byte) {
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
		_ = cA.Send(envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": resp.DaemonID}))
		fr, ok := cA.RecvTimeout(time.Second)
		if !ok || fr.Typ != envelope.TypSESSION_BOUND {
			t.Fatalf("bound %v %d", ok, fr.Typ)
		}
		// drain daemon SESSION_BOUND
		_, _ = dA.RecvTimeout(50 * time.Millisecond)
		return cA, fr.RouteID
	}

	for i := 0; i < 10; i++ {
		_, rid := attach()
		_ = dA.Send(envelope.JSON(envelope.TypSESSION_ESTABLISHED, rid, map[string]any{"v": 1, "route_id": fmtRID(rid)}))
		time.Sleep(15 * time.Millisecond)
	}
	c11, rid11 := attach()
	_ = dA.Send(envelope.JSON(envelope.TypSESSION_ESTABLISHED, rid11, map[string]any{"v": 1, "route_id": fmtRID(rid11)}))
	fr, ok := c11.RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypERROR {
		t.Fatalf("want too_many on client, got ok=%v typ=%d payload=%s", ok, fr.Typ, fr.Payload)
	}
	var body envelope.ErrorBody
	_ = json.Unmarshal(fr.Payload, &body)
	if body.Code != "too_many_devices" {
		t.Fatalf("%+v", body)
	}
}

func TestThirdResumeHelloKicked(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(64)
	stop := make(chan struct{})
	go func() {
		for {
			f, ok := dH.RecvTimeout(15 * time.Millisecond)
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

	attach := func() *Pipe {
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
		_ = cA.Send(envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": resp.DaemonID}))
		fr, ok := cA.RecvTimeout(time.Second)
		if !ok || fr.Typ != envelope.TypSESSION_BOUND {
			t.Fatalf("bound %v %d", ok, fr.Typ)
		}
		_, _ = dA.RecvTimeout(50 * time.Millisecond)
		return cA
	}

	c1 := attach()
	time.Sleep(2 * time.Millisecond)
	c2 := attach()
	time.Sleep(2 * time.Millisecond)
	c3 := attach()
	est, resume := h.BindKindCounts(resp.DaemonID)
	if resume != 2 {
		t.Fatalf("resumehello=%d want 2 (never a 3rd) est=%d", resume, est)
	}
	if est != 0 {
		t.Fatalf("established %d", est)
	}
	fr, ok := c1.RecvTimeout(time.Second)
	if !ok || fr.Typ != envelope.TypERROR {
		t.Fatalf("oldest ResumeHello want kicked ok=%v typ=%d", ok, fr.Typ)
	}
	var body envelope.ErrorBody
	_ = json.Unmarshal(fr.Payload, &body)
	if body.Code != "kicked" {
		t.Fatalf("%+v", body)
	}
	_ = c2
	_ = c3
}

func fmtRID(r [16]byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, 32)
	for i := 0; i < 16; i++ {
		out[2*i] = hexdigits[r[i]>>4]
		out[2*i+1] = hexdigits[r[i]&15]
	}
	return string(out)
}
