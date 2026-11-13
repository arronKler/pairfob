package daemon

import (
	"context"
	"sync"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

func TestMonitorAndPhoneShareDisplaySnapshotButNotAuthority(t *testing.T) {
	hold := make(chan struct{})
	rt := &stallObserve{inner: runtime.NewFake(), hold: hold}
	e := NewEngine(nil, nil, rt)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		if _, err := e.monitorSnapshot(context.Background(), runtime.DefaultSession()); err != nil {
			t.Error(err)
		}
	}()
	waitUntil(t, func() bool { return e.reads.waiterCount("S\x00") == 1 })
	go func() {
		defer wg.Done()
		if _, err := e.snapshot(nil); err != nil {
			t.Error(err)
		}
	}()
	waitUntil(t, func() bool { return e.reads.waiterCount("S\x00") == 2 })
	go func() {
		defer wg.Done()
		if _, err := e.workspaceSnapshot(nil); err != nil {
			t.Error(err)
		}
	}()
	waitUntil(t, func() bool { return rt.nCalls() == 2 })
	close(hold)
	wg.Wait()
	if rt.nCalls() != 2 {
		t.Fatalf("calls=%d want one display plus one authority", rt.nCalls())
	}
	if _, err := e.snapshot(nil); err != nil {
		t.Fatal(err)
	}
	if rt.nCalls() != 3 {
		t.Fatal("a later read must remain fresh")
	}
}

func TestCancelledMonitorDoesNotCancelPhoneRead(t *testing.T) {
	hold := make(chan struct{})
	rt := &stallObserve{inner: runtime.NewFake(), hold: hold}
	e := NewEngine(nil, nil, rt)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := e.monitorSnapshot(ctx, runtime.DefaultSession()); done <- err }()
	waitUntil(t, func() bool { return rt.nCalls() == 1 })
	phone := make(chan error, 1)
	go func() { _, err := e.snapshot(nil); phone <- err }()
	waitUntil(t, func() bool { return e.reads.waiterCount("S\x00") == 2 })
	cancel()
	if err := <-done; err != context.Canceled {
		t.Fatalf("cancel=%v", err)
	}
	close(hold)
	if err := <-phone; err != nil {
		t.Fatal(err)
	}
}

func TestMonitorDoesNotReuseDisplayReadFromBeforeItsInvalidation(t *testing.T) {
	hold := make(chan struct{})
	rt := &stallObserve{inner: runtime.NewFake(), hold: hold}
	e := NewEngine(nil, nil, rt)
	phone := make(chan struct{})
	go func() { defer close(phone); _, _ = e.snapshot(nil) }()
	waitUntil(t, func() bool { return rt.nCalls() == 1 })
	monitor := make(chan runtime.Snapshot, 1)
	go func() {
		value, err := e.monitorSnapshot(context.Background(), runtime.DefaultSession())
		if err != nil {
			t.Error(err)
		}
		monitor <- value
	}()
	close(hold)
	<-phone
	if got := <-monitor; got.CapturedAt != 2 || rt.nCalls() != 2 {
		t.Fatalf("monitor reused pre-event read: %+v calls=%d", got, rt.nCalls())
	}
}

func TestRuntimePokesFoldDuplicatesPreserveDistinctAndAvailability(t *testing.T) {
	input := make(chan runtimePoke, 64)
	for i := 0; i < 20; i++ {
		input <- runtimePoke{"agent_status", "p1"}
	}
	input <- runtimePoke{"agent_status", "p2"}
	input <- runtimePoke{"herdr_offline", ""}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := make(chan runtimePoke, 64)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runRuntimePokes(ctx, input, func(reason, pane string) { output <- runtimePoke{reason, pane} })
	}()
	select {
	case got := <-output:
		if got.reason != "herdr_offline" {
			t.Fatalf("availability held behind status: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no availability")
	}
	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case got := <-output:
			seen[got.paneID] = true
		case <-time.After(time.Second):
			t.Fatal("missing status")
		}
	}
	if !seen["p1"] || !seen["p2"] {
		t.Fatal(seen)
	}
	cancel()
	<-done
	if len(output) != 0 {
		t.Fatal("duplicate status escaped")
	}
	t.Log("burst invalidations: baseline=22 candidate=3; distinct pane/availability information preserved")
}
