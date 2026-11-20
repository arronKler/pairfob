package remotedesktop

import (
	"time"

	"github.com/pion/rtcp"
)

// A single RTCP reader owns the rate estimate. The helper writer consumes only
// the latest target and at most one outstanding keyframe request.
type videoFeedback struct {
	keyframes         chan struct{}
	rates             chan int
	lastKey, lastRate time.Time
	rate, ceiling     int
}

func newVideoFeedback(quality string) *videoFeedback {
	capacity := 8000000
	switch quality {
	case "motion":
		capacity = 4500000
	case "detail":
		capacity = 12000000
	}
	return &videoFeedback{rate: capacity, ceiling: capacity, keyframes: make(chan struct{}, 1), rates: make(chan int, 1)}
}

func (f *videoFeedback) receive(packets []rtcp.Packet, now time.Time) {
	loss := -1
	target := f.ceiling
	key := false
	for _, packet := range packets {
		switch report := packet.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			key = true
		case *rtcp.ReceiverReport:
			for _, block := range report.Reports {
				loss = max(loss, int(block.FractionLost))
			}
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			if report.Bitrate > 0 && report.Bitrate < float32(target) {
				target = int(report.Bitrate)
			}
		}
	}
	if key && now.Sub(f.lastKey) >= 250*time.Millisecond {
		f.lastKey = now
		select {
		case f.keyframes <- struct{}{}:
		default:
		}
	}
	if now.Sub(f.lastRate) < time.Second {
		return
	}
	// RR loss is a fraction of 256. Decrease promptly and recover slowly.
	switch {
	case loss >= 13:
		target = min(target, f.rate*3/4)
	case loss >= 0 && loss <= 2 && now.Sub(f.lastRate) >= 3*time.Second:
		target = min(target, f.rate+250000)
	default:
		target = min(target, f.rate)
	}
	target = max(500000, target)
	if target == f.rate {
		return
	}
	f.rate, f.lastRate = target, now
	select {
	case <-f.rates:
	default:
	}
	f.rates <- target
}
