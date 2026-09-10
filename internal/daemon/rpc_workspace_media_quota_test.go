package daemon

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pairfob/internal/workspace"
)

func starveMediaDisk(engine *Engine) {
	b := &engine.media.bandwidth
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sessionDiskRate = 0
	b.sessionDiskBurst = 0
	b.diskGlobal.rate = 0
	b.diskGlobal.burst = 0
	b.diskGlobal.tokens = 0
	b.diskGlobal.last = time.Now()
	for _, sess := range b.session {
		sess.disk.rate = 0
		sess.disk.burst = 0
		sess.disk.tokens = 0
		sess.disk.last = time.Now()
	}
}

func freezeMediaDisk(engine *Engine) {
	b := &engine.media.bandwidth
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sessionDiskRate = 0
	b.diskGlobal.rate = 0
	for _, sess := range b.session {
		sess.disk.rate = 0
	}
}

func TestWorkspaceMediaOpenRejectedBeforeHash(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "clip.bin"), make([]byte, 256<<10+1), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, client := runtimeRPCClient(t, fake)
	var reads atomic.Int64
	restore := workspace.SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	starveMediaDisk(engine)
	_, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "clip.bin"})
	if err == nil || err.Error() != "rate_limited" {
		t.Fatalf("starved open err=%v", err)
	}
	if got := reads.Load(); got != 0 {
		t.Fatalf("read/hashed %d bytes before quota reject", got)
	}
	engine.media.mu.Lock()
	leaked := len(engine.media.byHandle)
	engine.media.mu.Unlock()
	if leaked != 0 {
		t.Fatalf("leaked %d handles after rejected open", leaked)
	}
}

func TestWorkspaceMediaRepeatedOpenPaysConsumedDisk(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "burst.bin"), make([]byte, 256<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "again.bin"), make([]byte, 64<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, client := runtimeRPCClient(t, fake)
	var reads atomic.Int64
	restore := workspace.SetMediaReadObserver(func(n int) { reads.Add(int64(n)) })
	defer restore()
	// Keep the initial burst fixed across both opens, including the first hash.
	freezeMediaDisk(engine)
	if _, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "burst.bin"}); err != nil {
		t.Fatal(err)
	}
	first := reads.Load()
	if first != 256<<10 {
		t.Fatalf("first open read %d", first)
	}
	_, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "again.bin"})
	if err == nil || err.Error() != "rate_limited" {
		t.Fatalf("second open err=%v", err)
	}
	if got := reads.Load(); got != first {
		t.Fatalf("second open hashed extra %d bytes", got-first)
	}
}

func TestWorkspaceMediaOpenCancelDropsBucketsWithoutResurrect(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "clip.bin"), make([]byte, 2<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, client := runtimeRPCClient(t, fake)
	started := make(chan struct{})
	unwound := make(chan struct{})
	engine.media.bandwidth.sleep = func(ctx context.Context, d time.Duration) error {
		select {
		case <-started:
		default:
			close(started)
		}
		<-ctx.Done()
		return ctx.Err()
	}
	go func() {
		_, _ = client.RPCTimeout("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "clip.bin"}, time.Second)
		close(unwound)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("open did not wait for disk quota")
	}
	route := clientRoute(engine, client)
	engine.mu.Lock()
	oldSession := engine.sessions[route]
	engine.mu.Unlock()
	engine.closeSession(route, "", false)
	deadline := time.Now().Add(2 * time.Second)
	for engine.media.bandwidth.sessionLive(oldSession) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	engine.media.mu.Lock()
	leaked := len(engine.media.byHandle)
	engine.media.mu.Unlock()
	if leaked != 0 {
		t.Fatalf("leaked %d handles", leaked)
	}
	if engine.media.bandwidth.sessionLive(oldSession) {
		t.Fatal("session buckets still live after disconnect")
	}
	if _, err := engine.mediaLiveContext(oldSession); err != errMediaClosed {
		t.Fatalf("bind after disconnect err=%v", err)
	}
	select {
	case <-unwound:
	case <-time.After(3 * time.Second):
		t.Fatal("client open did not unwind")
	}
}

func TestWorkspaceMediaQuotaWaitDoesNotHoldSendMu(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "a.bin"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b.bin"), make([]byte, 64<<10), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, client := runtimeRPCClient(t, fake)
	_ = openMedia(t, client, "a.bin")
	route := clientRoute(engine, client)
	engine.mu.Lock()
	s := engine.sessions[route]
	engine.mu.Unlock()
	if s == nil {
		t.Fatal("missing session")
	}
	engine.media.bandwidth.mu.Lock()
	engine.media.bandwidth.sessionDiskRate = 64 << 10
	engine.media.bandwidth.diskGlobal.rate = 64 << 10
	if sess := engine.media.bandwidth.session[s]; sess != nil {
		sess.disk.rate = 64 << 10
		sess.disk.tokens = 0
		sess.disk.last = time.Now()
	}
	engine.media.bandwidth.diskGlobal.tokens = 0
	engine.media.bandwidth.diskGlobal.last = time.Now()
	engine.media.bandwidth.mu.Unlock()
	var once sync.Once
	held := make(chan struct{})
	engine.media.bandwidth.sleep = func(ctx context.Context, d time.Duration) error {
		once.Do(func() { close(held) })
		acquired := make(chan struct{})
		go func() {
			s.sendMu.Lock()
			s.sendMu.Unlock()
			close(acquired)
		}()
		select {
		case <-acquired:
		case <-time.After(2 * time.Second):
			t.Error("quota wait held sendMu")
		}
		return context.DeadlineExceeded
	}
	_, err := client.RPC("WorkspaceMediaOpen", map[string]any{"pane_id": "w0:p1", "path": "b.bin"})
	if err == nil || err.Error() != "rate_limited" {
		t.Fatalf("waiting open err=%v", err)
	}
	select {
	case <-held:
	default:
		t.Fatal("admit did not wait")
	}
}

func TestWorkspaceMediaOpenLeavesNetworkTokens(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "clip.bin"), make([]byte, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, client := runtimeRPCClient(t, fake)
	opened := openMedia(t, client, "clip.bin")
	route := clientRoute(engine, client)
	engine.mu.Lock()
	mediaOwner := engine.sessions[route]
	engine.mu.Unlock()
	engine.media.bandwidth.mu.Lock()
	engine.media.bandwidth.sessionNetRate = 0
	engine.media.bandwidth.netGlobal.rate = 0
	if sess := engine.media.bandwidth.session[mediaOwner]; sess != nil {
		sess.net.rate = 0
	}
	engine.media.bandwidth.mu.Unlock()
	sess, global := engine.media.bandwidth.snapshotTokens(mediaOwner, mediaQuotaNet)
	if sess != float64(mediaSessionNetBurst) || global != float64(mediaGlobalNetBurst) {
		t.Fatalf("open spent network tokens sess=%v global=%v", sess, global)
	}
	handle := opened["handle"].(string)
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{
		"handle": handle, "offset": 0, "length": workspace.MediaChunkBytes,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("WorkspaceMediaRead", map[string]any{
		"handle": handle, "offset": 0, "length": workspace.MediaChunkBytes,
	}); err != nil {
		t.Fatal(err)
	}
	sess, _ = engine.media.bandwidth.snapshotTokens(mediaOwner, mediaQuotaNet)
	cost := mediaNetCost(workspace.MediaChunkBytes)
	want := float64(mediaSessionNetBurst) - 2*float64(cost)
	if sess != want {
		t.Fatalf("repeated range tokens=%v want %v", sess, want)
	}
}
