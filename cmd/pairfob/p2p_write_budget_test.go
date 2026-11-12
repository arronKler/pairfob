package main

import (
	"context"
	"encoding/binary"
	"testing"
	"time"

	"pairfob/internal/envelope"
)

func TestP2PWriteBudgetTransfersBurstWithoutClosing(t *testing.T) {
	pair := openP2PTestPair(t)
	defer pair.cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for i := range 48 {
		payload := make([]byte, 130000)
		binary.BigEndian.PutUint64(payload, uint64(i))
		frame := envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: [16]byte{1}, Payload: payload}
		if err := pair.link.WaitWritable(ctx, envelope.HeaderSize+len(payload)); err != nil {
			t.Fatal(err)
		}
		if err := pair.link.Send(frame); err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
	}
	for i := range 48 {
		select {
		case frame := <-pair.received:
			if len(frame.Payload) != 130000 || binary.BigEndian.Uint64(frame.Payload) != uint64(i) {
				t.Fatal("lost or reordered data")
			}
		case <-ctx.Done():
			t.Fatal("burst did not arrive")
		}
	}
	select {
	case <-pair.closed:
		t.Fatal("burst closed epoch")
	default:
	}
}

func TestP2PWriteBudgetRejectsCancelledAndImpossibleWaits(t *testing.T) {
	pair := openP2PTestPair(t)
	defer pair.cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := pair.link.WaitWritable(ctx, 100); err != context.Canceled {
		t.Fatalf("cancel: %v", err)
	}
	if err := pair.link.WaitWritable(context.Background(), p2pMaxFrameBytes+1); err == nil {
		t.Fatal("accepted oversized frame")
	}
	if !pair.link.WriteReady(100) {
		t.Fatal("rejected wait closed a healthy connection")
	}
	pair.link.Close()
	if err := pair.link.WaitWritable(context.Background(), 100); err == nil {
		t.Fatal("wait on closed connection succeeded")
	}
}
