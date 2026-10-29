package runtime

import (
	"context"
	"io"
	"os/exec"
	"testing"
	"time"
)

func TestHerdrTerminalInitialBurstStaysOrdered(t *testing.T) {
	binary := writeTerminalFixture(t, `
printf '%s\n' '{"type":"terminal.frame","seq":1,"encoding":"ansi","width":80,"height":24,"full":true,"bytes":""}' '{"type":"terminal.frame","seq":2,"encoding":"ansi","width":80,"height":24,"full":false,"bytes":""}'
read line
`)
	for i := 0; i < 20; i++ {
		h := NewHerdr("/unused")
		h.TerminalBinary = binary
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		c, err := h.OpenTerminal(ctx, TerminalOpen{PaneID: "w0:p1", Cols: 80, Rows: 24})
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		for seq := uint64(1); seq <= 2; seq++ {
			select {
			case event := <-c.Events():
				if event.Frame == nil || event.Frame.Sequence != seq {
					c.Close()
					t.Fatalf("wanted frame %d, got %+v", seq, event)
				}
			case <-time.After(2 * time.Second):
				c.Close()
				t.Fatal("missing frame")
			}
		}
		c.Close()
	}
}

func TestHerdrTerminalExitFollowsInitialFrame(t *testing.T) {
	h := NewHerdr("/unused")
	h.TerminalBinary = writeTerminalFixture(t, `printf '%s\n' '{"type":"terminal.frame","seq":1,"encoding":"ansi","width":80,"height":24,"full":true,"bytes":""}'`)
	c, err := h.OpenTerminal(context.Background(), TerminalOpen{PaneID: "w0:p1", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if first := <-c.Events(); first.Frame == nil {
		t.Fatal("close overtook initial frame")
	}
	if second := <-c.Events(); second.Closed == nil {
		t.Fatal("missing close event")
	}
}

func TestHerdrTerminalCloseUnblocksFullEventQueue(t *testing.T) {
	h := NewHerdr("/unused")
	h.TerminalBinary = writeTerminalFixture(t, `
i=1
while [ "$i" -le 40 ]; do
printf '{"type":"terminal.frame","seq":%s,"encoding":"ansi","width":80,"height":24,"full":true,"bytes":""}\n' "$i"
i=$((i+1))
done
read line
`)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	opened, err := h.OpenTerminal(ctx, TerminalOpen{PaneID: "w0:p1", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	c := opened.(*herdrTerminal)
	defer c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for len(c.events) < cap(c.events) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(c.events) != cap(c.events) {
		t.Fatal("fixture did not fill queue")
	}
	c.Close()
	select {
	case <-c.done:
	case <-time.After(2 * time.Second):
		t.Fatal("reader leaked behind full event queue")
	}
}

func TestHerdrTerminalCloseBoundsBlockedPipeAndWriterLock(t *testing.T) {
	for _, busy := range []bool{false, true} {
		r, w := io.Pipe()
		c := &herdrTerminal{cmd: &exec.Cmd{}, stdin: w, done: make(chan struct{}), stop: make(chan struct{})}
		input := make(chan error, 1)
		if busy {
			go func() { input <- c.Input([]byte("test")) }()
			// Read one byte to prove Input owns writeMu, then stop consuming.
			var b [1]byte
			if _, err := r.Read(b[:]); err != nil {
				t.Fatal(err)
			}
		}
		finished := make(chan struct{})
		go func() { c.Close(); close(finished) }()
		select {
		case <-finished:
		case <-time.After(1500 * time.Millisecond):
			r.Close()
			t.Fatal("close blocked before its deadline")
		}
		close(c.done)
		r.Close()
		if busy {
			select {
			case <-input:
			case <-time.After(time.Second):
				t.Fatal("input writer leaked")
			}
		}
	}
}
