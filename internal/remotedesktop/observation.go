package remotedesktop

import (
	"sync"
	"time"
)

// RTPTime is taken from the marker packet of the last completely written frame.
// EncodeMS is measured entirely on the Mac's encoder clock.
type StreamObservation struct {
	RTPTime  uint32  `json:"rtp_time"`
	Healthy  bool    `json:"healthy"`
	EncodeMS float64 `json:"encode_ms"`
}

const captureFreshness = 2500 * time.Millisecond

type captureQuestion struct {
	token uint64
	at    time.Time
}

type videoObservation struct {
	mu        sync.Mutex
	questions [4]captureQuestion
	token     uint64
	lastAsk   time.Time
	lastKey   time.Time
	expires   time.Time
	latest    uint64 // latest known display revision, even while encoding
	delivered uint64
	sample    StreamObservation
	requests  chan uint64
}

func (v *videoObservation) observe(now time.Time, observe, keyframe bool, feedback *videoFeedback) StreamObservation {
	v.mu.Lock()
	defer v.mu.Unlock()
	if observe && now.Sub(v.lastAsk) >= 250*time.Millisecond {
		v.token++
		q := captureQuestion{v.token, now}
		// One queued native query suffices. Never extend an older answer's lifetime.
		select {
		case v.requests <- q.token:
			v.questions[q.token%uint64(len(v.questions))] = q
			v.lastAsk = now
		default:
		}
	}
	if keyframe && now.Sub(v.lastKey) >= 2*time.Second {
		select {
		case feedback.keyframes <- struct{}{}:
		default:
		}
		v.lastKey = now
	}
	out := v.sample
	out.Healthy = observe && v.delivered != 0 && v.latest == v.delivered && now.Before(v.expires)
	return out
}

func (v *videoObservation) resetKeyframe() {
	v.mu.Lock()
	v.lastKey = time.Time{}
	v.mu.Unlock()
}

func (v *videoObservation) capture(revision, token, ageMicros uint64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.latest = revision
	if token == 0 {
		if ageMicros >= uint64(captureFreshness/time.Microsecond) {
			v.expires = time.Time{}
		}
		return // a capture change in advance of its encoder callback
	}
	q := v.questions[token%uint64(len(v.questions))]
	if q.token != token {
		return
	}
	v.expires = time.Time{}
	if ageMicros < uint64(captureFreshness/time.Microsecond) {
		// An answer can be delayed in the helper pipe. Bound its age by the
		// Go-side question time and the capture age measured on the native clock.
		v.expires = q.at.Add(captureFreshness - time.Duration(ageMicros)*time.Microsecond)
	}
}

func (v *videoObservation) sent(revision uint64, timestamp uint32, encodeMicros uint64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.delivered = revision
	v.sample = StreamObservation{RTPTime: timestamp, EncodeMS: float64(encodeMicros) / 1000}
}
