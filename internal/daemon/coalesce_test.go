package daemon

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"pairfob/internal/runtime"
)

type stallObserve struct {
	inner runtime.Runtime
	mu    sync.Mutex
	calls int
	hold  chan struct{}
}

func (s *stallObserve) Describe(ctx context.Context, session runtime.SessionRef) (runtime.Descriptor, error) {
	return s.inner.Describe(ctx, session)
}

func (s *stallObserve) Execute(ctx context.Context, session runtime.SessionRef, operationID string, command runtime.Command) (runtime.Receipt, error) {
	return s.inner.Execute(ctx, session, operationID, command)
}

func (s *stallObserve) Observe(ctx context.Context, session runtime.SessionRef, query runtime.Query) (runtime.View, error) {
	s.mu.Lock()
	s.calls++
	n := s.calls
	hold := s.hold
	s.mu.Unlock()
	if hold != nil {
		select {
		case <-hold:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	view, err := s.inner.Observe(ctx, session, query)
	if err != nil {
		return nil, err
	}
	switch value := view.(type) {
	case runtime.SnapshotView:
		value.Snapshot.CapturedAt = int64(n)
		return value, nil
	case runtime.PaneReadView:
		value.Text = fmt.Sprintf("%s#%d", value.Text, n)
		return value, nil
	default:
		return view, nil
	}
}

func (s *stallObserve) nCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for coalesced observe")
}

func TestCoalesceOverlappingSnapshotsShareOneRuntimeCall(t *testing.T) {
	fake := runtime.NewFake()
	hold := make(chan struct{})
	rt := &stallObserve{inner: fake, hold: hold}
	engine := NewEngine(nil, nil, rt)
	key, ok := observeKey(nil, runtime.SnapshotQuery{})
	if !ok {
		t.Fatal("snapshot must coalesce")
	}

	var wg sync.WaitGroup
	got := make([]runtime.Snapshot, 2)
	errs := make([]error, 2)
	wg.Add(1)
	go func() {
		defer wg.Done()
		got[0], errs[0] = engine.snapshot(nil)
	}()
	waitUntil(t, func() bool { return engine.reads.waiterCount(key) >= 1 && rt.nCalls() == 1 })

	wg.Add(1)
	go func() {
		defer wg.Done()
		got[1], errs[1] = engine.snapshot(nil)
	}()
	waitUntil(t, func() bool { return engine.reads.waiterCount(key) >= 2 })
	if n := rt.nCalls(); n != 1 {
		t.Fatalf("overlapping Snapshot started %d Observe calls", n)
	}
	close(hold)
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("snapshot errors: %v %v", errs[0], errs[1])
	}
	if got[0].CapturedAt != 1 || !reflect.DeepEqual(got[0], got[1]) {
		t.Fatalf("waiters did not share one snapshot: %+v vs %+v", got[0], got[1])
	}

	third, err := engine.snapshot(nil)
	if err != nil || third.CapturedAt != 2 || rt.nCalls() != 2 {
		t.Fatalf("completed Snapshot was cached: captured=%d calls=%d err=%v", third.CapturedAt, rt.nCalls(), err)
	}
}

func TestCoalesceDifferentPaneReadsDoNotShare(t *testing.T) {
	fake := runtime.NewFake()
	fake.Panes["w0:p2"] = &runtime.PaneState{Text: "other"}
	hold := make(chan struct{})
	rt := &stallObserve{inner: fake, hold: hold}
	engine := NewEngine(nil, nil, rt)

	firstKey, _ := observeKey(nil, runtime.PaneReadQuery{PaneID: "w0:p1", Source: runtime.SourceVisible, Format: runtime.FormatText, Lines: 40})
	secondKey, _ := observeKey(nil, runtime.PaneReadQuery{PaneID: "w0:p2", Source: runtime.SourceVisible, Format: runtime.FormatText, Lines: 40})

	var wg sync.WaitGroup
	got := make([]runtime.View, 2)
	errs := make([]error, 2)
	wg.Add(1)
	go func() {
		defer wg.Done()
		got[0], errs[0] = engine.observe(nil, runtime.PaneReadQuery{PaneID: "w0:p1", Source: runtime.SourceVisible, Format: runtime.FormatText, Lines: 40})
	}()
	waitUntil(t, func() bool { return engine.reads.waiterCount(firstKey) >= 1 && rt.nCalls() == 1 })

	wg.Add(1)
	go func() {
		defer wg.Done()
		got[1], errs[1] = engine.observe(nil, runtime.PaneReadQuery{PaneID: "w0:p2", Source: runtime.SourceVisible, Format: runtime.FormatText, Lines: 40})
	}()
	waitUntil(t, func() bool { return engine.reads.waiterCount(secondKey) >= 1 && rt.nCalls() == 2 })
	close(hold)
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("pane read errors: %v %v", errs[0], errs[1])
	}
	first, _ := got[0].(runtime.PaneReadView)
	second, _ := got[1].(runtime.PaneReadView)
	if first.Text == second.Text {
		t.Fatalf("different pane_id shared a result: %q", first.Text)
	}
	if rt.nCalls() != 2 {
		t.Fatalf("different pane_id Observe calls=%d", rt.nCalls())
	}
}

func TestCoalesceInflightWaitersGetSameResult(t *testing.T) {
	fake := runtime.NewFake()
	hold := make(chan struct{})
	rt := &stallObserve{inner: fake, hold: hold}
	engine := NewEngine(nil, nil, rt)
	query := runtime.PaneReadQuery{PaneID: "w0:p1", Source: runtime.SourceVisible, Format: runtime.FormatText, Lines: 40}
	key, ok := observeKey(nil, query)
	if !ok {
		t.Fatal("pane read must coalesce")
	}

	var wg sync.WaitGroup
	got := make([]runtime.View, 3)
	errs := make([]error, 3)
	for i := 0; i < 3; i++ {
		if i > 0 {
			waitUntil(t, func() bool { return engine.reads.waiterCount(key) >= i })
		}
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], errs[i] = engine.observe(nil, query)
		}()
	}
	waitUntil(t, func() bool { return engine.reads.waiterCount(key) >= 3 })
	if n := rt.nCalls(); n != 1 {
		t.Fatalf("in-flight PaneRead started %d Observe calls", n)
	}
	close(hold)
	wg.Wait()
	first, ok := got[0].(runtime.PaneReadView)
	if !ok || errs[0] != nil || first.Text == "" {
		t.Fatalf("first waiter result=%v err=%v", got[0], errs[0])
	}
	for i := 1; i < 3; i++ {
		if errs[i] != nil || !reflect.DeepEqual(got[i], got[0]) {
			t.Fatalf("waiter %d result=%v err=%v want %v", i, got[i], errs[i], got[0])
		}
	}
}
