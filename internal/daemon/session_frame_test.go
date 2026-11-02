package daemon

import (
	"encoding/json"
	"testing"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
)

func TestEstablishedFWDOpenFailureReportsBadFrame(t *testing.T) {
	link := newFailNthConn(0)
	engine, session, _ := establishedSendSession(t, link)
	session.c2s = &aead.Direction{Key: randomTestBytes(t, 32), Dir: aead.DirClient}

	engine.handleFWD(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: session.routeID, Payload: []byte("not a sealed frame")})

	n, frames, _ := link.snapshot()
	if n != 1 {
		t.Fatalf("frames=%d, want one ERROR to the phone", n)
	}
	if frames[0].Typ != envelope.TypERROR {
		t.Fatalf("typ=0x%02x, want ERROR", frames[0].Typ)
	}
	var body envelope.ErrorBody
	if err := json.Unmarshal(frames[0].Payload, &body); err != nil {
		t.Fatalf("decode ERROR: %v", err)
	}
	if body.Code != "bad_frame" {
		t.Fatalf("code=%q, want bad_frame", body.Code)
	}
	waitSessionGone(t, engine, session.routeID)
}
