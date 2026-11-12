package daemon

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/runtime"
)

func TestInteractiveReplyRunsBetweenTerminalParts(t *testing.T) {
	link := newFailNthConn(0)
	entered, release := make(chan struct{}), make(chan struct{})
	var first, unblock sync.Once
	defer unblock.Do(func() { close(release) })
	link.onSend = func() { first.Do(func() { close(entered); <-release }) }
	e, s, key := establishedSendSession(t, link)
	slot := &terminalSlot{id: benchmarkTerminalID}
	s.terminal = slot
	terminalDone := make(chan bool, 1)
	go func() {
		ok, _ := e.sendTerminalFrame(s, slot, runtime.TerminalFrame{Sequence: 1, Width: 80, Height: 24, Data: make([]byte, maxTerminalFrameBytes)})
		terminalDone <- ok
	}()
	<-entered
	replyDone := make(chan bool, 1)
	go func() { replyDone <- e.reply(s, "interactive", map[string]any{"ok": true}) }()
	deadline := time.Now().Add(time.Second)
	for s.interactiveWait.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if s.interactiveWait.Load() == 0 {
		t.Fatal("reply did not reach admission")
	}
	unblock.Do(func() { close(release) })
	if !<-replyDone || !<-terminalDone {
		t.Fatal("send failed")
	}
	_, frames, _ := link.snapshot()
	rx := &aead.Direction{Key: key, Dir: aead.DirServer}
	for index, frame := range frames {
		body, err := aead.Open(rx, s.routeID, frame.Payload)
		if err != nil {
			t.Fatal(err)
		}
		var message struct {
			ID string `json:"id"`
		}
		if err = json.Unmarshal(body, &message); err != nil {
			t.Fatal(err)
		}
		if index == 1 && message.ID != "interactive" {
			t.Fatalf("second envelope is not the interactive response: %s", message.ID)
		}
	}
	if len(frames) != 44 {
		t.Fatalf("lost terminal parts: %d", len(frames))
	}
}
