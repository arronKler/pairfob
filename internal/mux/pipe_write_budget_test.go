package mux

import (
	"context"
	"testing"
	"time"

	"pairfob/internal/envelope"
)

func TestPipeWriteBudgetAccountsBytesAndDrains(t *testing.T) {
	a, b := NewPipePair(128)
	defer a.Close()
	defer b.Close()
	large := envelope.Frame{Version: 1, Typ: envelope.TypFWD, Payload: make([]byte, envelope.MaxPayload)}
	if !a.WriteReady(envelope.HeaderSize + envelope.MaxPayload) {
		t.Fatal("empty pipe is not writable")
	}
	if err := a.Send(large); err != nil {
		t.Fatal(err)
	}
	if a.WriteReady(envelope.HeaderSize + envelope.MaxPayload) {
		t.Fatal("frame-count cap concealed a full byte budget")
	}
	if !a.WriteReady(pipeControlHeadroom) {
		t.Fatal("large frame consumed interactive headroom")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- a.WaitWritable(ctx, envelope.HeaderSize+envelope.MaxPayload) }()
	if _, ok := b.Recv(); !ok {
		t.Fatal("missing frame")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if b.queued.Load() != 0 {
		t.Fatal("drain did not release bytes")
	}
}

func TestPipeWriteBudgetCancellationCloseAndBufferedDrain(t *testing.T) {
	for _, timed := range []bool{false, true} {
		a, b := NewPipePair(8)
		_ = a.Send(envelope.Frame{Payload: make([]byte, envelope.MaxPayload)})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := a.WaitWritable(ctx, 24); err != context.Canceled {
			t.Fatal(err)
		}
		b.Close()
		if err := a.WaitWritable(context.Background(), 24); err != errClosed {
			t.Fatal(err)
		}
		var ok bool
		if timed {
			_, ok = b.RecvTimeout(time.Second)
		} else {
			_, ok = b.Recv()
		}
		if !ok || b.queued.Load() != 0 {
			t.Fatal("closed pipe lost or double-accounted buffered frame")
		}
		if err := a.Send(envelope.Frame{}); err != errClosed || b.queued.Load() != 0 {
			t.Fatal("failed send leaked byte budget")
		}
		a.Close()
	}
}
