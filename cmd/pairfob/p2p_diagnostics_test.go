package main

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"pairfob/internal/mux"
)

func TestTransportErrorClassificationOmitsErrorText(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{nil, ""}, {context.Canceled, "cancelled"}, {context.DeadlineExceeded, "timeout"},
		{io.ErrUnexpectedEOF, "eof"}, {net.ErrClosed, "closed"},
		{errors.New("remote 192.0.2.1 credential=secret"), "other"},
	} {
		if got := transportErrorClass(tc.err); got != tc.want {
			t.Fatalf("got %q, want %q", got, tc.want)
		}
	}
}

func TestWebRTCClosePreservesFirstCauseAndPreCleanupState(t *testing.T) {
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	c := &webRTCConn{peer: peer, onClose: func(mux.Conn) {}, createdAt: time.Now().Add(-time.Second)}
	c.noteClose("data_channel_error", io.EOF)
	before := c.CloseInfo()
	c.Close()
	c.noteClose("peer_closed", nil)
	after := c.CloseInfo()
	if after != before {
		t.Fatalf("cleanup overwrote cause: before=%+v after=%+v", before, after)
	}
	if after.Reason != "data_channel_error" || after.ErrorClass != "eof" || after.PeerState != "new" || after.LifetimeMS < 1000 {
		t.Fatalf("missing evidence: %+v", after)
	}
}
