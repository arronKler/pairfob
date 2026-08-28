package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

type blockedDescribeRuntime struct {
	*runtime.Fake
	started chan struct{}
	release chan struct{}
}

func (r *blockedDescribeRuntime) Describe(ctx context.Context, session runtime.SessionRef) (runtime.Descriptor, error) {
	select {
	case r.started <- struct{}{}:
	default:
	}
	select {
	case <-r.release:
		return r.Fake.Describe(ctx, session)
	case <-ctx.Done():
		return runtime.Descriptor{}, ctx.Err()
	}
}

func TestSlowRPCOnOneRouteDoesNotBlockAnother(t *testing.T) {
	engineSide, peer := mux.NewPipePair(16)
	rt := &blockedDescribeRuntime{Fake: runtime.NewFake(), started: make(chan struct{}, 1), release: make(chan struct{})}
	engine := NewEngine(nil, engineSide, rt)
	makeSession := func(routeByte, keyByte byte) (*sess, []byte) {
		route := [16]byte{routeByte}
		key := make([]byte, 32)
		for i := range key {
			key[i] = keyByte + byte(i)
		}
		s := &sess{
			routeID: route, deviceID: "dev_1234567" + string(rune('0'+routeByte)), state: "established",
			s2c:      &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer},
			rpcQueue: make(chan rpcRequest, sessionRPCQueueSize), rpcStop: make(chan struct{}),
		}
		engine.sessions[route] = s
		go engine.runSessionRPC(s)
		return s, key
	}
	first, _ := makeSession(1, 10)
	second, secondKey := makeSession(2, 50)
	defer stopSessionRPC(first)
	defer stopSessionRPC(second)
	first.rpcQueue <- rpcRequest{id: "slow", op: "GetConfig", params: json.RawMessage(`{}`)}
	select {
	case <-rt.started:
	case <-time.After(time.Second):
		t.Fatal("slow request did not start")
	}
	second.rpcQueue <- rpcRequest{id: "fast", op: "Ping", params: json.RawMessage(`{"t_ms":7}`)}
	frame, ok := peer.RecvTimeout(300 * time.Millisecond)
	if !ok || frame.RouteID != second.routeID {
		t.Fatalf("fast route was blocked: ok=%v route=%x", ok, frame.RouteID)
	}
	plain, err := aead.Open(&aead.Direction{Key: secondKey, Dir: aead.DirServer}, second.routeID, frame.Payload)
	if err != nil || !json.Valid(plain) {
		t.Fatalf("fast reply=%s err=%v", plain, err)
	}
	close(rt.release)
}
