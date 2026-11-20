package remotedesktop

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestStandbyFollowsACGrantAndDaemonExit(t *testing.T) {
	h := LocalHost{Dir: t.TempDir()}
	if err := h.save(nil, true, "control", "primary"); err != nil {
		t.Fatal(err)
	}
	changed := make(chan struct{}, 1)
	var ac atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	edges := make(chan bool, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.monitorStandby(ctx, changed, time.Millisecond, ac.Load, func() (func(), error) { edges <- true; return func() { edges <- false }, nil })
	}()
	expect := func(want bool) {
		t.Helper()
		select {
		case got := <-edges:
			if got != want {
				t.Fatal(got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("missed assertion transition", want)
		}
	}
	save := func(mode string) {
		t.Helper()
		if _, err := h.configure(mode, true, nil); err != nil {
			t.Fatal(err)
		}
		changed <- struct{}{}
	}
	save("standby-on")
	ac.Store(true)
	expect(true)
	ac.Store(false)
	expect(false)
	ac.Store(true)
	expect(true)
	save("standby-off")
	expect(false)
	save("standby-on")
	expect(true)
	cancel()
	expect(false)
	<-done
}
