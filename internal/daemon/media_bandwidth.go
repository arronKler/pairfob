package daemon

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

const (
	mediaSessionDiskPerSec = 8 << 20
	mediaSessionDiskBurst  = 256 << 10
	mediaGlobalDiskPerSec  = 32 << 20
	mediaGlobalDiskBurst   = 1 << 20
	mediaSessionNetPerSec  = 2 << 20
	mediaSessionNetBurst   = 256 << 10
	mediaGlobalNetPerSec   = 8 << 20
	mediaGlobalNetBurst    = 1 << 20
	mediaOpenDeadline      = 20 * time.Second
)

type mediaQuotaKind int

const (
	mediaQuotaDisk mediaQuotaKind = iota
	mediaQuotaNet
)

type mediaWindow struct {
	tokens float64
	last   time.Time
	rate   float64
	burst  float64
}

func (w *mediaWindow) refill(now time.Time) {
	if w.last.IsZero() {
		w.tokens = w.burst
		w.last = now
		return
	}
	if w.rate > 0 {
		w.tokens += now.Sub(w.last).Seconds() * w.rate
	}
	if w.tokens > w.burst {
		w.tokens = w.burst
	}
	w.last = now
}

func (w *mediaWindow) waitFor(need float64) time.Duration {
	if need > w.burst {
		return -1
	}
	if w.tokens >= need {
		return 0
	}
	if w.rate <= 0 {
		return -1
	}
	wait := time.Duration((need - w.tokens) / w.rate * float64(time.Second))
	if wait < time.Millisecond {
		wait = time.Millisecond
	}
	return wait
}

type mediaSessionQuota struct {
	disk mediaWindow
	net  mediaWindow
}

type mediaBandwidth struct {
	mu               sync.Mutex
	diskGlobal       mediaWindow
	netGlobal        mediaWindow
	sessionDiskRate  float64
	sessionDiskBurst float64
	sessionNetRate   float64
	sessionNetBurst  float64
	session          map[*sess]*mediaSessionQuota
	now              func() time.Time
	sleep            func(context.Context, time.Duration) error
}

func newMediaBandwidth() mediaBandwidth {
	return mediaBandwidth{
		diskGlobal:       mediaWindow{rate: mediaGlobalDiskPerSec, burst: mediaGlobalDiskBurst},
		netGlobal:        mediaWindow{rate: mediaGlobalNetPerSec, burst: mediaGlobalNetBurst},
		sessionDiskRate:  mediaSessionDiskPerSec,
		sessionDiskBurst: mediaSessionDiskBurst,
		sessionNetRate:   mediaSessionNetPerSec,
		sessionNetBurst:  mediaSessionNetBurst,
		session:          map[*sess]*mediaSessionQuota{},
	}
}

func mediaNetCost(payload int) int64 {
	if payload <= 0 {
		return 0
	}
	return int64(base64.StdEncoding.EncodedLen(payload))
}

func (b *mediaBandwidth) nowTime() time.Time {
	if b.now != nil {
		return b.now()
	}
	return time.Now()
}

func (b *mediaBandwidth) sleepCtx(ctx context.Context, d time.Duration) error {
	if b.sleep != nil {
		return b.sleep(ctx, d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// bind is called only after mediaLiveContext checks the authenticated session,
// with the media registry lock held through registration. The owner is the
// immutable session epoch (a *sess), NOT the mutable route id: a P2P commit keeps
// the same logical session while moving it to a new route, so its quota follows
// the session. Session teardown takes the registry lock before removing quota
// state; admission never creates it.
func (b *mediaBandwidth) bind(owner *sess) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.session[owner] == nil {
		b.session[owner] = &mediaSessionQuota{
			disk: mediaWindow{rate: b.sessionDiskRate, burst: b.sessionDiskBurst},
			net:  mediaWindow{rate: b.sessionNetRate, burst: b.sessionNetBurst},
		}
	}
	return nil
}

func (b *mediaBandwidth) dropSession(owner *sess) {
	b.mu.Lock()
	delete(b.session, owner)
	b.mu.Unlock()
}

func (b *mediaBandwidth) admit(ctx context.Context, owner *sess, kind mediaQuotaKind, n int64) error {
	if n <= 0 {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		if err := ctx.Err(); err != nil {
			return b.closedOrRate(owner, err)
		}
		wait, err := b.tryAdmit(owner, kind, n)
		if err != nil {
			return err
		}
		if wait < 0 {
			return errMediaRate
		}
		if wait == 0 {
			return nil
		}
		if err := b.sleepCtx(ctx, wait); err != nil {
			return b.closedOrRate(owner, err)
		}
	}
}

func (b *mediaBandwidth) closedOrRate(owner *sess, err error) error {
	b.mu.Lock()
	sess := b.session[owner]
	b.mu.Unlock()
	if sess == nil || errors.Is(err, context.Canceled) {
		return errMediaClosed
	}
	return errMediaRate
}

func (b *mediaBandwidth) sessionLive(owner *sess) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.session[owner]
	return ok
}

func (b *mediaBandwidth) snapshotTokens(owner *sess, kind mediaQuotaKind) (sess, global float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.nowTime()
	if kind == mediaQuotaNet {
		b.netGlobal.refill(now)
		global = b.netGlobal.tokens
		if s := b.session[owner]; s != nil {
			s.net.refill(now)
			sess = s.net.tokens
		}
		return
	}
	b.diskGlobal.refill(now)
	global = b.diskGlobal.tokens
	if s := b.session[owner]; s != nil {
		s.disk.refill(now)
		sess = s.disk.tokens
	}
	return
}

func (b *mediaBandwidth) tryAdmit(owner *sess, kind mediaQuotaKind, n int64) (time.Duration, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	sess := b.session[owner]
	if sess == nil {
		return 0, errMediaClosed
	}
	now := b.nowTime()
	global := &b.diskGlobal
	win := &sess.disk
	if kind == mediaQuotaNet {
		global = &b.netGlobal
		win = &sess.net
	}
	global.refill(now)
	win.refill(now)
	need := float64(n)
	gw := global.waitFor(need)
	sw := win.waitFor(need)
	if gw < 0 || sw < 0 {
		return -1, nil
	}
	wait := gw
	if sw > wait {
		wait = sw
	}
	if wait > 0 {
		return wait, nil
	}
	global.tokens -= need
	win.tokens -= need
	return 0, nil
}
