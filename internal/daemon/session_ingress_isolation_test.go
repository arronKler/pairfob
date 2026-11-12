package daemon

import (
	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"sync"
	"testing"
	"time"
)

func TestSlowOutputDoesNotBlockOtherRelaySession(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	link := newFailNthConn(0)
	link.onSend = func() { close(entered); <-release }
	engine, first, key := establishedSendSession(t, link)
	first.c2s = &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirClient}
	slot := &terminalSlot{id: benchmarkTerminalID}
	first.terminal = slot
	second := &sess{routeID: [16]byte{2}, state: "established", c2s: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirClient}, rpcQueue: make(chan rpcRequest, 8)}
	engine.sessions[second.routeID] = second
	in, peer := mux.NewPipePair(8)
	engine.Conn = in
	defer in.Close()
	stop := make(chan struct{})
	defer close(stop)
	sendDone := make(chan bool, 1)
	go func() {
		ok, _ := engine.sendTerminalFrame(first, slot, runtime.TerminalFrame{Sequence: 1, Width: 80, Height: 24, Data: []byte("hello")})
		sendDone <- ok
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("sender did not enter")
	}
	loopDone := make(chan struct{})
	go func() { defer close(loopDone); engine.RecvLoop(stop) }()
	for _, s := range []*sess{first, second} {
		payload, err := aead.Seal(&aead.Direction{Key: key, Dir: aead.DirClient}, s.routeID, []byte(`{"v":1,"id":"req_audit","op":"Snapshot","params":{}}`))
		if err != nil {
			t.Fatal(err)
		}
		if err = peer.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload}); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-second.rpcQueue:
	case <-time.After(time.Second):
		t.Fatal("slow output blocked another relay session")
	}
	unblock()
	for _, s := range []*sess{first} {
		select {
		case <-s.rpcQueue:
		case <-time.After(time.Second):
			t.Fatal("request did not proceed after releasing output")
		}
	}
	if !<-sendDone {
		t.Fatal("terminal send failed")
	}
	in.Close()
	select {
	case <-loopDone:
	case <-time.After(time.Second):
		t.Fatal("receive loop did not close")
	}
}
