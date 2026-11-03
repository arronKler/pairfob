package mux

import (
	"encoding/json"
	"testing"
	"time"

	"pairfob/internal/envelope"
)

func TestPhoneDropUnpinsDaemon(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)

	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": daemonID}))
	bound, ok := cA.RecvTimeout(time.Second)
	if !ok || bound.Typ != envelope.TypSESSION_BOUND {
		t.Fatalf("session bound: ok=%v typ=%d", ok, bound.Typ)
	}
	if fr, ok := dA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypSESSION_BOUND {
		t.Fatal("daemon SESSION_BOUND")
	}
	h.HandleDaemon(dH, envelope.JSON(envelope.TypSESSION_ESTABLISHED, bound.RouteID, map[string]any{
		"v": 1, "route_id": fmtRID(bound.RouteID),
	}))
	if fr, ok := cA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypSESSION_ESTABLISHED {
		t.Fatal("established")
	}
	if est, _ := h.BindKindCounts(daemonID); est != 1 {
		t.Fatalf("established=%d", est)
	}

	h.DropConn(cH)
	assertErrorCode(t, dA, "unpaired")
	if est, resume := h.BindKindCounts(daemonID); est != 0 || resume != 0 {
		t.Fatalf("bind counts established=%d resume=%d", est, resume)
	}
}

func TestDaemonRouteErrorClosesAnyCode(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)

	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": daemonID}))
	bound, ok := cA.RecvTimeout(time.Second)
	if !ok || bound.Typ != envelope.TypSESSION_BOUND {
		t.Fatalf("session bound: ok=%v typ=%d", ok, bound.Typ)
	}
	_, _ = dA.RecvTimeout(time.Second)
	h.HandleDaemon(dH, envelope.JSON(envelope.TypSESSION_ESTABLISHED, bound.RouteID, map[string]any{
		"v": 1, "route_id": fmtRID(bound.RouteID),
	}))
	if fr, ok := cA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypSESSION_ESTABLISHED {
		t.Fatal("established")
	}

	h.HandleDaemon(dH, envelope.JSON(envelope.TypERROR, bound.RouteID, envelope.ErrorBody{
		Code: "unpaired", RouteID: fmtRID(bound.RouteID), Message: "aead failed",
	}))
	assertErrorCode(t, cA, "unpaired")
	if est, resume := h.BindKindCounts(daemonID); est != 0 || resume != 0 {
		t.Fatalf("zombie bind established=%d resume=%d", est, resume)
	}
}

func TestResumeTimeoutUnpinsDaemon(t *testing.T) {
	h := NewHub("kt")
	h.resumeWait = 20 * time.Millisecond
	dA, dH := NewPipePair(8)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": daemonID}))
	if fr, ok := cA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypSESSION_BOUND {
		t.Fatal("bound")
	}
	if fr, ok := dA.RecvTimeout(time.Second); !ok || fr.Typ != envelope.TypSESSION_BOUND {
		t.Fatal("daemon bound")
	}
	assertErrorCode(t, cA, "unpaired")
	assertErrorCode(t, dA, "unpaired")
	if est, resume := h.BindKindCounts(daemonID); est != 0 || resume != 0 {
		t.Fatalf("counts established=%d resume=%d", est, resume)
	}
}

func TestDaemonRouteErrorDoesNotEchoUnpin(t *testing.T) {
	h := NewHub("kt")
	dA, dH := NewPipePair(16)
	daemonID, _, _ := registerTestDaemon(t, h, dA, dH)
	cA, cH := NewPipePair(8)
	h.HandleClient(cH, envelope.JSON(envelope.TypHELLO_CLIENT, [16]byte{}, map[string]any{"v": 1, "protocol": 1}))
	h.HandleClient(cH, envelope.JSON(envelope.TypSESSION_ATTACH, [16]byte{}, map[string]any{"v": 1, "daemon_id": daemonID}))
	bound, _ := cA.RecvTimeout(time.Second)
	_, _ = dA.RecvTimeout(time.Second)
	h.HandleDaemon(dH, envelope.JSON(envelope.TypSESSION_ESTABLISHED, bound.RouteID, map[string]any{
		"v": 1, "route_id": fmtRID(bound.RouteID),
	}))
	_, _ = cA.RecvTimeout(time.Second)

	h.HandleDaemon(dH, envelope.JSON(envelope.TypERROR, bound.RouteID, envelope.ErrorBody{
		Code: "unpaired", RouteID: fmtRID(bound.RouteID), Message: "aead failed",
	}))
	assertErrorCode(t, cA, "unpaired")
	if fr, ok := dA.RecvTimeout(50 * time.Millisecond); ok {
		var body envelope.ErrorBody
		_ = json.Unmarshal(fr.Payload, &body)
		t.Fatalf("daemon received echo %d %s", fr.Typ, body.Code)
	}
}
