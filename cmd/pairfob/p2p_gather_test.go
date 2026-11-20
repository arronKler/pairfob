package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

func TestWebRTCAcceptorAnswersWithoutWaitingOutAnUnansweredSTUNServer(t *testing.T) {
	caller, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
	protocol := p2pDataChannelProtocol
	channel, err := caller.CreateDataChannel(p2pDataChannelLabel, &webrtc.DataChannelInit{Ordered: boolPointer(true), Protocol: &protocol})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	channel.OnOpen(func() { close(opened) })
	offer, err := caller.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	callerGathered := webrtc.GatheringCompletePromise(caller)
	if err := caller.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-callerGathered

	// A documentation address: its STUN binding is never answered, so pion
	// would keep gathering open for its full five seconds.
	acceptor := &webRTCAcceptor{configuration: webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:192.0.2.1:3478"}}},
	}}
	// The deadline only bounds a stuck acceptor; the early-answer behavior is
	// asserted below, against the four-second mark, not against this guard.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	started := time.Now()
	answer, link, err := acceptor.Accept(ctx, caller.LocalDescription().SDP, func(mux.Conn, envelope.Frame) {}, func(mux.Conn) {})
	if err != nil {
		t.Fatal(err)
	}
	defer closeP2PTestWithin(t, "acceptor", link.Close)
	if elapsed := time.Since(started); elapsed >= 4*time.Second {
		t.Fatalf("answered after %v", elapsed)
	}
	if !strings.Contains(answer, "a=candidate:") {
		t.Fatalf("answer carries no candidate:\n%s", answer)
	}
	if err := caller.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal("data channel did not open on the early answer")
	}
}
