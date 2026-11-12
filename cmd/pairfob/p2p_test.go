package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

// These tests assert frame transport and queue closure, not ICE latency. Give
// instrumented builds time to connect on a busy host, including one shard per
// core running the other cmd/pairfob tests beside this one; p2p_gather_test.go
// checks the product's answer budget separately.
const p2pTransportTestWait = 30 * time.Second

// closeP2PTestWithin bounds a Pion teardown. After a failed ICE restart,
// PeerConnection.Close can block in DTLS. Without this, one failed assertion
// holds the test binary until the shard's go test -timeout.
func closeP2PTestWithin(t *testing.T, label string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Logf("%s close did not return within 5s", label)
	}
}

func TestWebRTCAcceptorCarriesPairfobFramesBothWays(t *testing.T) {
	caller, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
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
	ctx, cancel := context.WithTimeout(context.Background(), p2pTransportTestWait)
	defer cancel()
	answer, link, err := acceptor.Accept(ctx, caller.LocalDescription().SDP, func(_ mux.Conn, frame envelope.Frame) {
		daemonFrames <- frame
	}, func(mux.Conn) {
		closed <- struct{}{}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closeP2PTestWithin(t, "acceptor", link.Close)
	if err := caller.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatalf("data channel did not open: peer=%s ice=%s", caller.ConnectionState(), caller.ICEConnectionState())
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

	restarter, ok := link.(interface {
		Restart(context.Context, string) (string, error)
	})
	if !ok {
		t.Fatal("webRTCConn does not implement Restart")
	}
	restartOffer, err := caller.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		t.Fatal(err)
	}
	restartGathered := webrtc.GatheringCompletePromise(caller)
	if err := caller.SetLocalDescription(restartOffer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-restartGathered:
	case <-ctx.Done():
		t.Fatal("restart ICE gathering timed out")
	}
	restartAnswer, err := restarter.Restart(ctx, caller.LocalDescription().SDP)
	if err != nil {
		t.Fatal(err)
	}
	if err := caller.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: restartAnswer}); err != nil {
		t.Fatal(err)
	}
	ping := envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: route, Payload: []byte{9, 8, 7}}
	if err := link.Send(ping); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-callerFrames:
		if got.Typ != envelope.TypFWD || string(got.Payload) != string(ping.Payload) {
			t.Fatalf("post-restart frame=%+v", got)
		}
	case <-ctx.Done():
		t.Fatal("caller did not receive frame after ICE restart")
	}

	closeP2PTestWithin(t, "acceptor", link.Close)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close callback was not delivered")
	}
}

func boolPointer(value bool) *bool { return &value }

type p2pTestPair struct {
	received    <-chan envelope.Frame
	link        *webRTCConn
	closed      chan struct{}
	onCloseHook func()
	cleanup     func()
}

func openP2PTestPair(t *testing.T) *p2pTestPair {
	t.Helper()
	caller, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	protocol := p2pDataChannelProtocol
	channel, err := caller.CreateDataChannel(p2pDataChannelLabel, &webrtc.DataChannelInit{
		Ordered:  boolPointer(true),
		Protocol: &protocol,
	})
	if err != nil {
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal(err)
	}
	received := make(chan envelope.Frame, 64)
	var assembler p2pFrameAssembler
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		wire, err := assembler.Push(message.Data)
		if err == nil && wire != nil {
			frame, err := envelope.Decode(wire)
			if err == nil {
				received <- frame
			}
		}
	})
	opened := make(chan struct{})
	channel.OnOpen(func() { close(opened) })
	offer, err := caller.CreateOffer(nil)
	if err != nil {
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(caller)
	if err := caller.SetLocalDescription(offer); err != nil {
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal("caller ICE gathering timed out")
	}
	pair := &p2pTestPair{closed: make(chan struct{}, 1), received: received}
	ctx, cancel := context.WithTimeout(context.Background(), p2pTransportTestWait)
	acceptor := &webRTCAcceptor{configuration: webrtc.Configuration{}}
	answer, link, err := acceptor.Accept(ctx, caller.LocalDescription().SDP, func(mux.Conn, envelope.Frame) {}, func(mux.Conn) {
		if pair.onCloseHook != nil {
			pair.onCloseHook()
		}
		select {
		case pair.closed <- struct{}{}:
		default:
		}
	})
	if err != nil {
		cancel()
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal(err)
	}
	rtc, ok := link.(*webRTCConn)
	if !ok {
		cancel()
		closeP2PTestWithin(t, "acceptor", link.Close)
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal("Accept did not return webRTCConn")
	}
	pair.link = rtc
	if err := caller.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		cancel()
		closeP2PTestWithin(t, "acceptor", link.Close)
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		cancel()
		closeP2PTestWithin(t, "acceptor", link.Close)
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		t.Fatal("data channel did not open")
	}
	pair.cleanup = func() {
		closeP2PTestWithin(t, "acceptor", link.Close)
		closeP2PTestWithin(t, "caller", func() { _ = caller.Close() })
		cancel()
	}
	return pair
}

func TestWebRTCQueueFullClosesEpochAndDoesNotDeadlock(t *testing.T) {
	pair := openP2PTestPair(t)
	defer pair.cleanup()
	pair.link.maxBuffered = 1
	frame := envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: [16]byte{1}, Payload: []byte{1, 2, 3}}

	var sendMu sync.Mutex
	pair.onCloseHook = func() {
		sendMu.Lock()
		sendMu.Unlock()
	}
	sendMu.Lock()
	done := make(chan error, 1)
	go func() { done <- pair.link.Send(frame) }()
	select {
	case err := <-done:
		if err == nil || err.Error() != "P2P send queue is full" {
			t.Fatalf("queue-full Send = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send deadlocked while the caller held sendMu")
	}
	sendMu.Unlock()

	select {
	case <-pair.closed:
	case <-time.After(time.Second):
		t.Fatal("queue-full did not close the P2P epoch")
	}
	if err := pair.link.Send(frame); err == nil {
		t.Fatal("Send succeeded on the closed epoch after a simulated buffer drain")
	}
}
