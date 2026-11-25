package runtime

import (
	"context"
	"encoding/binary"
	"testing"
	"time"
)

func TestCoreStreamSinkByteBudgetAndDrain(t *testing.T) {
	sink := newCoreStreamSink(nil)
	defer sink.abort()
	item := coreStreamItem{kind: coreKindData, payload: make([]byte, 256<<10)}
	accepted := 0
	for sink.deliver(item) {
		accepted++
		if accepted > 20 {
			t.Fatal("stream queue is unbounded")
		}
	}
	sink.mu.Lock()
	if sink.bytes > coreStreamQueueBytes {
		t.Fatal("queue exceeded its byte budget")
	}
	sink.mu.Unlock()
	sink.close()
	count := 0
	for range sink.items {
		count++
	}
	if count != accepted {
		t.Fatalf("drained %d/%d accepted frames", count, accepted)
	}
}

func TestCoreStreamSinkAbortReleasesUnreadWorker(t *testing.T) {
	sink := newCoreStreamSink(nil)
	sink.deliver(coreStreamItem{kind: coreKindData, payload: []byte("unread")})
	sink.abort()
	for {
		select {
		case _, ok := <-sink.items:
			if !ok {
				return
			}
		case <-time.After(time.Second):
			t.Fatal("detached stream worker did not stop")
		}
	}
}

func TestCoreConnCreditsOnlyConsumedFramesAndKeepsRPCResponsive(t *testing.T) {
	conn, log, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
		return coreScriptReply{result: map[string]any{"ok": true}}
	})
	if err != nil {
		t.Fatal(err)
	}
	// A DATA followed by CLOSE can arrive before the caller watches the stream.
	conn.routeStream(7, coreStreamItem{kind: coreKindData, payload: []byte("before-attach")})
	conn.endStream(7)
	items := conn.watchStream(7)
	// The FIFO send is blocked, so no credit can precede consumption.
	if log.hasFrame(7, coreKindCredit) {
		t.Fatal("unconsumed history was credited")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var result map[string]any
	if err := conn.Call(ctx, "server.status", nil, &result); err != nil {
		t.Fatalf("stalled stream blocked RPC: %v", err)
	}
	item, ok := <-items
	if !ok || string(item.payload) != "before-attach" {
		t.Fatalf("CLOSE lost pending replay: %+v", item)
	}
	if _, ok := <-items; ok {
		t.Fatal("stream stayed open after drained CLOSE")
	}
	waitForCore(t, func() bool { return log.hasFrame(7, coreKindCredit) })
	frames := log.framesOf(7)
	if len(frames) != 1 || binary.LittleEndian.Uint32(frames[0].payload) != uint32(len(item.payload)) {
		t.Fatal("incorrect consumed-byte credit")
	}
}

func TestCoreConnWatchStreamClosesOnByteOverflow(t *testing.T) {
	conn, _, err := startCoreScript(t, coreScriptHello(), func(coreScriptRequest) coreScriptReply { return coreScriptReply{result: map[string]any{}} })
	if err != nil {
		t.Fatal(err)
	}
	conn.streamsMu.Lock()
	for range 6 {
		item := coreStreamItem{kind: coreKindData, payload: make([]byte, 1<<20)}
		conn.pendingIn[7] = append(conn.pendingIn[7], item)
		conn.pendingBytes += coreStreamItemBytes(item)
	}
	conn.streamsMu.Unlock()
	items := conn.watchStream(7)
	count := 0
	for {
		select {
		case _, ok := <-items:
			if !ok {
				if count == 0 || count >= 6 || !conn.streamEnded(7) {
					t.Fatalf("invalid overflow result: count=%d", count)
				}
				return
			}
			count++
		case <-time.After(time.Second):
			t.Fatal("overflowed stream remained open")
		}
	}
}
