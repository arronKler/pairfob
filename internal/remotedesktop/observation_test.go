package remotedesktop

import (
	"testing"
	"time"
)

func TestDesktopObservationNeedsRecentCaptureAndCompleteRTP(t *testing.T) {
	var v videoObservation
	v.requests = make(chan uint64, 1)
	feedback := newVideoFeedback("balanced")
	now := time.Now()
	if v.observe(now, false, false, feedback).Healthy || len(v.requests) != 0 {
		t.Fatal("legacy viewer opted into observation")
	}
	question := func(at time.Time) uint64 {
		t.Helper()
		v.observe(at, true, false, feedback)
		select {
		case token := <-v.requests:
			return token
		default:
			t.Fatal("missing native capture query")
			return 0
		}
	}
	healthy := func(at time.Time) bool { return v.observe(at, true, false, feedback).Healthy }
	token := question(now)
	v.capture(8, token, 100_000)
	if healthy(now) {
		t.Fatal("capture alone established delivery")
	}
	v.sent(8, 0, 5_250) // zero is also a valid RTP timestamp
	if got := v.observe(now, true, false, feedback); !got.Healthy || got.RTPTime != 0 || got.EncodeMS != 5.25 {
		t.Fatal(got)
	}
	v.capture(9, 0, 0)
	if healthy(now) {
		t.Fatal("old frame matched an unsent display update")
	}
	v.sent(9, 123, 7_000)
	if !healthy(now) {
		t.Fatal("new revision did not settle")
	}
	// Even a completely written *new* keyframe cannot make an obsolete
	// display observation recent. The pipe can deliver an answer very late.
	v.capture(9, token, 100_000)
	v.sent(9, 999, 4_000)
	if healthy(now.Add(2410 * time.Millisecond)) {
		t.Fatal("late answer or cached keyframe extended freshness")
	}
	select {
	case next := <-v.requests:
		v.capture(9, next, 2_500_000)
	default:
		t.Fatal("expected subsequent capture query")
	}
	if healthy(now.Add(2420 * time.Millisecond)) {
		t.Fatal("expired native evidence accepted")
	}
}

func TestDesktopObservationCoalescesRecovery(t *testing.T) {
	v := videoObservation{requests: make(chan uint64, 1)}
	f := newVideoFeedback("motion")
	now := time.Now()
	v.observe(now, true, true, f)
	v.observe(now.Add(time.Second), true, true, f)
	if len(v.requests) != 1 || len(f.keyframes) != 1 {
		t.Fatal("unbounded controls")
	}
	<-f.keyframes
	v.observe(now.Add(1500*time.Millisecond), true, true, f)
	if len(f.keyframes) != 0 {
		t.Fatal("repeated keyframe inside recovery interval")
	}
	v.observe(now.Add(2*time.Second), true, true, f)
	if len(f.keyframes) != 1 {
		t.Fatal("recovery suppressed indefinitely")
	}
}

func TestDesktopObservedIdleKeepsOnePresentedFrame(t *testing.T) {
	v := videoObservation{requests: make(chan uint64, 1)}
	f := newVideoFeedback("balanced")
	now := time.Now()
	v.sent(1, 456, 1750)
	for i := 0; i <= 45; i++ {
		at := now.Add(time.Duration(i) * time.Second)
		v.observe(at, true, false, f)
		token := <-v.requests
		v.capture(1, token, 50_000)
		got := v.observe(at, true, false, f)
		if !got.Healthy || got.RTPTime != 456 || len(f.keyframes) != 0 {
			t.Fatalf("idle second %d, got %+v", i, got)
		}
	}
}
