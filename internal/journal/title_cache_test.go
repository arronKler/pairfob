package journal

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTitleSlowProviderDoesNotBlockCachedOtherBinding(t *testing.T) {
	r := &Reader{}
	a, b := Ref{Agent: "claude", Value: "a"}, Ref{Agent: "codex", Value: "b"}
	r.cachedTitle("b", b, func(Ref) (Title, bool) { return Title{Name: "cached"}, true })
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		r.cachedTitle("a", a, func(Ref) (Title, bool) { close(started); <-release; return Title{}, true })
		close(done)
	}()
	<-started
	defer func() { close(release); <-done }()
	other := make(chan Title, 1)
	go func() { other <- r.cachedTitle("b", b, func(Ref) (Title, bool) { return Title{}, true }) }()
	select {
	case title := <-other:
		if title.Name != "cached" {
			t.Fatal(title)
		}
	case <-time.After(time.Second):
		t.Fatal("cached title blocked behind provider I/O")
	}
}

func TestTitleSameBindingCoalescesAndCachesFromCompletion(t *testing.T) {
	r := &Reader{}
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	ref := Ref{Agent: "codex", Value: "a"}
	read := func(Ref) (Title, bool) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return Title{Name: "one"}, true
	}
	results := make(chan Title, 2)
	go func() { results <- r.cachedTitle("a", ref, read) }()
	<-started
	go func() { results <- r.cachedTitle("a", ref, read) }()
	close(release)
	for i := 0; i < 2; i++ {
		if got := <-results; got.Name != "one" {
			t.Fatal(got)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate provider reads", calls.Load())
	}
}

func TestTitleCacheEvictsOneBindingWithoutFlushingOthers(t *testing.T) {
	r := &Reader{titleCache: make(map[string]titleCacheEntry)}
	for i := 0; i < maxTraceCacheEntries; i++ {
		r.titleCache[string(rune('a'+i))] = titleCacheEntry{at: time.Now()}
	}
	r.cachedTitle("new", Ref{Value: "new"}, func(Ref) (Title, bool) { return Title{Name: "new"}, true })
	if len(r.titleCache) != maxTraceCacheEntries {
		t.Fatal("cache was flushed", len(r.titleCache))
	}
}

func TestTitleProviderConcurrencyIsBounded(t *testing.T) {
	r := &Reader{}
	started := make(chan struct{}, maxTraceCacheEntries)
	release := make(chan struct{})
	var done sync.WaitGroup
	defer done.Wait()
	defer close(release)
	for i := 0; i < maxTraceCacheEntries; i++ {
		done.Add(1)
		go func(i int) {
			defer done.Done()
			r.cachedTitle(fmt.Sprint(i), Ref{Value: fmt.Sprint(i)}, func(Ref) (Title, bool) {
				started <- struct{}{}
				<-release
				return Title{Name: "loaded"}, true
			})
		}(i)
	}
	for i := 0; i < maxTraceCacheEntries; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("provider did not start")
		}
	}
	called := false
	got := r.cachedTitle("overflow", Ref{Value: "overflow"}, func(Ref) (Title, bool) {
		called = true
		return Title{}, true
	})
	if called || got.Name != "" {
		t.Fatal("provider concurrency exceeded bound")
	}
}

func TestTitleSlowReadGetsFullCacheLifetimeAfterCompletion(t *testing.T) {
	now := time.Unix(100, 0)
	r := &Reader{now: func() time.Time { return now }}
	ref := Ref{Value: "slow"}
	calls := 0
	read := func(Ref) (Title, bool) {
		calls++
		now = now.Add(10 * time.Second)
		return Title{Name: "slow"}, true
	}
	r.cachedTitle("root", ref, read)
	now = now.Add(time.Second)
	r.cachedTitle("root", ref, read)
	if calls != 1 {
		t.Fatal("provider result expired before its cache lifetime", calls)
	}
}
