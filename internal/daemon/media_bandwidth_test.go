package daemon

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
	return nil
}

func testBandwidth() (*mediaBandwidth, *sess) {
	b := newMediaBandwidth()
	owner := &sess{}
	if err := b.bind(owner); err != nil {
		panic(err)
	}
	return &b, owner
}

func TestMediaAdmitRejectsWholeFileAboveBurst(t *testing.T) {
	b, owner := testBandwidth()
	if err := b.admit(context.Background(), owner, mediaQuotaDisk, int64(mediaSessionDiskBurst)+1); err != errMediaRate {
		t.Fatalf("whole-file admit above burst err=%v", err)
	}
}

func TestMediaAdmitWaitUsesSlowerBucketNotMinRate(t *testing.T) {
	b, owner := testBandwidth()
	now := time.Unix(1000, 0)
	b.now = func() time.Time { return now }
	b.mu.Lock()
	b.netGlobal.tokens = 0
	b.netGlobal.rate = mediaGlobalNetPerSec
	b.netGlobal.last = now
	sess := b.session[owner]
	sess.net.tokens = mediaSessionNetBurst
	sess.net.rate = mediaSessionNetPerSec
	sess.net.last = now
	b.mu.Unlock()
	need := int64(64 << 10)
	wait, err := b.tryAdmit(owner, mediaQuotaNet, need)
	if err != nil {
		t.Fatal(err)
	}
	if wait <= 0 || wait > 15*time.Millisecond {
		t.Fatalf("wait=%s, want ~8ms from the empty 8 MiB/s global bucket", wait)
	}
}

func TestMediaDropDoesNotResurrectSessionBuckets(t *testing.T) {
	b, owner := testBandwidth()
	if err := b.admit(context.Background(), owner, mediaQuotaDisk, 64<<10); err != nil {
		t.Fatal(err)
	}
	b.dropSession(owner)
	if b.sessionLive(owner) {
		t.Fatal("dropped session still live")
	}
	if err := b.admit(context.Background(), owner, mediaQuotaDisk, 1); err != errMediaClosed {
		t.Fatalf("admit after drop err=%v", err)
	}
	if b.sessionLive(owner) {
		t.Fatal("admission resurrected dropped session tokens")
	}
}

func TestMediaCancelDoesNotRefundConsumedTokens(t *testing.T) {
	clock := &fakeClock{now: time.Unix(50, 0)}
	b, owner := testBandwidth()
	b.now = clock.Now
	b.sleep = clock.Sleep
	b.mu.Lock()
	b.sessionDiskRate = 0
	b.diskGlobal.rate = 0
	sess := b.session[owner]
	sess.disk.rate = 0
	sess.disk.tokens = mediaSessionDiskBurst
	sess.disk.last = clock.Now()
	b.diskGlobal.tokens = mediaGlobalDiskBurst
	b.diskGlobal.last = clock.Now()
	b.mu.Unlock()
	if err := b.admit(context.Background(), owner, mediaQuotaDisk, mediaSessionDiskBurst); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := b.admit(ctx, owner, mediaQuotaDisk, 1); err != errMediaClosed && err != errMediaRate {
		t.Fatalf("cancelled admit err=%v", err)
	}
	sessTok, _ := b.snapshotTokens(owner, mediaQuotaDisk)
	if sessTok != 0 {
		t.Fatalf("cancelled admit refunded tokens: %v", sessTok)
	}
}

func TestMediaNetIndependentOfDisk(t *testing.T) {
	clock := &fakeClock{now: time.Unix(50, 0)}
	b, owner := testBandwidth()
	b.now = clock.Now
	b.sleep = clock.Sleep
	if err := b.admit(context.Background(), owner, mediaQuotaDisk, mediaSessionDiskBurst); err != nil {
		t.Fatal(err)
	}
	sess, global := b.snapshotTokens(owner, mediaQuotaNet)
	if sess != float64(mediaSessionNetBurst) || global != float64(mediaGlobalNetBurst) {
		t.Fatalf("disk admit spent network tokens sess=%v global=%v", sess, global)
	}
	cost := mediaNetCost(64 << 10)
	if err := b.admit(context.Background(), owner, mediaQuotaNet, cost); err != nil {
		t.Fatal(err)
	}
	if err := b.admit(context.Background(), owner, mediaQuotaNet, cost); err != nil {
		t.Fatal(err)
	}
	sess, _ = b.snapshotTokens(owner, mediaQuotaNet)
	if sess != float64(mediaSessionNetBurst)-2*float64(cost) {
		t.Fatalf("repeated range did not charge twice: sess=%v cost=%d", sess, cost)
	}
}
