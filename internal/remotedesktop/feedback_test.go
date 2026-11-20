package remotedesktop

import (
	"testing"
	"time"

	"github.com/pion/rtcp"
)

func TestDesktopVideoFeedback(t *testing.T) {
	f := newVideoFeedback("motion")
	now := time.Now()
	rr := func(loss uint8) rtcp.Packet {
		return &rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{FractionLost: loss}}}
	}
	f.receive([]rtcp.Packet{&rtcp.PictureLossIndication{}, rr(32)}, now)
	select {
	case <-f.keyframes:
	default:
		t.Fatal("missing keyframe")
	}
	if rate := <-f.rates; rate != 3375000 {
		t.Fatal(rate)
	}
	f.receive([]rtcp.Packet{&rtcp.FullIntraRequest{}, rr(45)}, now.Add(time.Millisecond))
	if len(f.keyframes) != 0 || len(f.rates) != 0 {
		t.Fatal("feedback flood")
	}
	f.receive([]rtcp.Packet{&rtcp.FullIntraRequest{}, &rtcp.ReceiverEstimatedMaximumBitrate{Bitrate: 300000}}, now.Add(time.Second))
	if len(f.keyframes) != 1 || <-f.rates != 500000 {
		t.Fatal("FIR or bitrate floor")
	}
	f.receive([]rtcp.Packet{rr(0)}, now.Add(5*time.Second))
	if <-f.rates != 750000 {
		t.Fatal("clean network did not recover")
	}
}
