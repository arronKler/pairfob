package daemon

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/runtime"
)

type gatedBudgetConn struct {
	*failNthConn
	ready   atomic.Bool
	waiting chan struct{}
	release chan struct{}
	once    sync.Once
	waitErr error
}

func newGatedBudgetConn() *gatedBudgetConn {
	return &gatedBudgetConn{failNthConn: newFailNthConn(0), waiting: make(chan struct{}), release: make(chan struct{})}
}
func (c *gatedBudgetConn) WriteReady(size int) bool { return size < 1024 || c.ready.Load() }
func (c *gatedBudgetConn) WaitWritable(ctx context.Context, size int) error {
	c.once.Do(func() { close(c.waiting) })
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.release:
		return c.waitErr
	}
}

func TestWriteBudgetWaitsBeforeSealAndAllowsInteractiveReply(t *testing.T) {
	link := newGatedBudgetConn()
	e, s, key := establishedSendSession(t, link)
	slot := &terminalSlot{id: benchmarkTerminalID}
	s.terminal = slot
	done := make(chan bool, 1)
	go func() {
		ok, _ := e.sendTerminalFrame(s, slot, runtime.TerminalFrame{Sequence: 1, Width: 80, Height: 24, Data: make([]byte, 4096)})
		done <- ok
	}()
	select {
	case <-link.waiting:
	case <-time.After(time.Second):
		t.Fatal("did not wait")
	}
	s.sendMu.Lock()
	seq := s.s2c.Seq
	s.sendMu.Unlock()
	if seq != 0 {
		t.Fatal("sequence consumed before writable")
	}
	if !e.reply(s, "interactive", map[string]any{"ok": true}) {
		t.Fatal("interactive response blocked")
	}
	link.ready.Store(true)
	close(link.release)
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("bulk send failed")
		}
	case <-time.After(time.Second):
		t.Fatal("drain did not resume")
	}
	_, frames, _ := link.snapshot()
	if len(frames) != 2 {
		t.Fatalf("frames=%d", len(frames))
	}
	rx := &aead.Direction{Key: key, Dir: aead.DirServer}
	for _, f := range frames {
		if _, err := aead.Open(rx, s.routeID, f.Payload); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWriteBudgetCancellationDoesNotSeal(t *testing.T) {
	link := newGatedBudgetConn()
	e, s, _ := establishedSendSession(t, link)
	done := make(chan bool, 1)
	go func() { done <- e.sendRPCResult(s, "bulk", map[string]any{"data": make([]byte, 4096)}, true) }()
	select {
	case <-link.waiting:
	case <-time.After(time.Second):
		t.Fatal("did not wait")
	}
	stopSessionRPC(s)
	select {
	case ok := <-done:
		if ok {
			t.Fatal("cancelled send succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not unblock")
	}
	_, frames, _ := link.snapshot()
	if len(frames) != 0 {
		t.Fatal("cancelled output was sealed and sent")
	}
	waitSessionGone(t, e, s.routeID)
}

func TestOldWriteWaitFailureDoesNotCloseMigratedSession(t *testing.T) {
	old := newGatedBudgetConn()
	old.waitErr = errors.New("old link closed")
	e, s, _ := establishedSendSession(t, old)
	done := make(chan bool, 1)
	go func() { done <- e.sendRPCResult(s, "bulk", map[string]any{"data": make([]byte, 4096)}, true) }()
	select {
	case <-old.waiting:
	case <-time.After(time.Second):
		t.Fatal("did not wait")
	}
	next := newFailNthConn(0)
	s.sendMu.Lock()
	e.mu.Lock()
	s.link = next
	e.mu.Unlock()
	s.sendMu.Unlock()
	close(old.release)
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("old link failure retired current transport")
		}
	case <-time.After(time.Second):
		t.Fatal("replacement was not used")
	}
	if !s.sendEpochLive() {
		t.Fatal("new epoch failed")
	}
	_, frames, _ := next.snapshot()
	if len(frames) != 1 {
		t.Fatalf("new link frames=%d", len(frames))
	}
}

func TestWriteBudgetKeepsInteractivePriorityWhileDraining(t *testing.T) {
	link := newGatedBudgetConn()
	e, s, _ := establishedSendSession(t, link)
	replyDone := make(chan bool, 1)
	go func() { replyDone <- e.reply(s, "large", map[string]any{"data": make([]byte, 4096)}) }()
	select {
	case <-link.waiting:
	case <-time.After(time.Second):
		t.Fatal("reply did not wait for capacity")
	}
	bulkAcquired := make(chan struct{})
	go func() { s.lockSend(true); close(bulkAcquired); s.unlockSend(true) }()
	select {
	case <-bulkAcquired:
		t.Fatal("bulk took capacity while an interactive reply was draining")
	case <-time.After(25 * time.Millisecond):
	}
	link.ready.Store(true)
	close(link.release)
	select {
	case ok := <-replyDone:
		if !ok {
			t.Fatal("reply failed")
		}
	case <-time.After(time.Second):
		t.Fatal("reply starved")
	}
	select {
	case <-bulkAcquired:
	case <-time.After(time.Second):
		t.Fatal("bulk did not resume after reply")
	}
}
