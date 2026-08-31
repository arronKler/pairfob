package main

import (
	"context"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

func TestWebRTCAcceptorCarriesPairfobFramesBothWays(t *testing.T) {
	caller, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Close()
	protocol := p2pDataChannelProtocol
	channel, err := caller.CreateDataChannel(p2pDataChannelLabel, &webrtc.DataChannelInit{
		Ordered:  boolPointer(true),
		Protocol: &protocol,
	})
	if err != nil {
		t.Fatal(err)
	}
	callerFrames := make(chan envelope.Frame, 1)
	var callerAssembler p2pFrameAssembler
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		encoded, assembleErr := callerAssembler.Push(message.Data)
		if assembleErr != nil || encoded == nil {
			return
		}
		frame, decodeErr := envelope.Decode(encoded)
		if decodeErr == nil {
			callerFrames <- frame
		}
	})
	opened := make(chan struct{})
	channel.OnOpen(func() { close(opened) })

	offer, err := caller.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(caller)
	if err := caller.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("caller ICE gathering timed out")
	}

	acceptor := &webRTCAcceptor{configuration: webrtc.Configuration{}}
	daemonFrames := make(chan envelope.Frame, 1)
	closed := make(chan struct{}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	answer, link, err := acceptor.Accept(ctx, caller.LocalDescription().SDP, func(_ mux.Conn, frame envelope.Frame) {
		daemonFrames <- frame
	}, func(mux.Conn) {
		closed <- struct{}{}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer link.Close()
	if err := caller.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal("data channel did not open")
	}

	route := [16]byte{1, 3, 5, 7}
	toDaemon := envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: route, Payload: make([]byte, 130_000)}
	toDaemon.Payload[0], toDaemon.Payload[len(toDaemon.Payload)-1] = 17, 29
	phoneChunks, err := splitP2PFrame(envelope.Encode(toDaemon))
	if err != nil {
		t.Fatal(err)
	}
	for _, chunk := range phoneChunks {
		if err := channel.Send(chunk); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case got := <-daemonFrames:
		if got.RouteID != route || len(got.Payload) != len(toDaemon.Payload) || got.Payload[0] != 17 || got.Payload[len(got.Payload)-1] != 29 {
			t.Fatalf("daemon frame=%+v", got)
		}
	case <-ctx.Done():
		t.Fatal("daemon did not receive frame")
	}

	toPhone := envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: route, Payload: make([]byte, 200_000)}
	toPhone.Payload[0], toPhone.Payload[len(toPhone.Payload)-1] = 31, 43
	if err := link.Send(toPhone); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-callerFrames:
		if got.RouteID != route || got.Typ != envelope.TypFWD || len(got.Payload) != len(toPhone.Payload) || got.Payload[0] != 31 || got.Payload[len(got.Payload)-1] != 43 {
			t.Fatalf("caller frame=%+v", got)
		}
	case <-ctx.Done():
		t.Fatal("caller did not receive frame")
	}

	link.Close()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close callback was not delivered")
	}
}

func boolPointer(value bool) *bool { return &value }
