package remotedesktop

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

func TestParseStopReason(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "locked", in: "PF_STOP_REASON:locked\n", want: "locked"},
		{name: "sleeping", in: "noise\nPF_STOP_REASON:sleeping  \n", want: "sleeping"},
		{name: "perm_screen", in: "PF_STOP_REASON:perm_screen\n", want: "perm_screen"},
		{name: "perm_accessibility", in: "PF_STOP_REASON:perm_accessibility\n", want: "perm_accessibility"},
		{name: "stopped_on_host", in: "PF_STOP_REASON:stopped_on_host\n", want: "stopped_on_host"},
		{name: "display_unavailable", in: "PF_STOP_REASON:display_unavailable\n", want: "display_unavailable"},
		{name: "long_line_before", in: strings.Repeat("x", 9000) + "\nPF_STOP_REASON:locked\n", want: "locked"},
		{name: "unknown_ignored", in: "PF_STOP_REASON:bogus\n", want: ""},
		{name: "empty", in: "", want: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseStopReason(strings.NewReader(tc.in)); got != tc.want {
				t.Fatalf("parseStopReason = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeReasonError(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		fallback string
		want     string
	}{
		{name: "locked", err: errors.New("Unlock this Mac to share a display"), want: "[reason:locked] Unlock this Mac to share a display"},
		{name: "sleeping_asleep", err: errors.New("The selected display is still asleep"), want: "[reason:sleeping] The selected display is still asleep"},
		{name: "sleeping_wake", err: errors.New("Unable to wake the selected display"), want: "[reason:sleeping] Unable to wake the selected display"},
		{name: "perm_screen", err: errors.New("Enable Screen Recording for Pairfob in System Settings on the Mac"), want: "[reason:perm_screen] Enable Screen Recording for Pairfob in System Settings on the Mac"},
		{name: "perm_accessibility", err: errors.New("Enable Accessibility for Pairfob in System Settings on the Mac"), want: "[reason:perm_accessibility] Enable Accessibility for Pairfob in System Settings on the Mac"},
		{name: "display_unavailable", err: errors.New("The display selected during desktop setup is unavailable"), want: "[reason:display_unavailable] The display selected during desktop setup is unavailable"},
		{name: "already_prefixed", err: errors.New("[reason:locked] Unlock this Mac to share a display"), want: "[reason:locked] Unlock this Mac to share a display"},
		{name: "fallback_used", err: errors.New("screen capture failed"), fallback: "perm_screen", want: "[reason:perm_screen] screen capture failed"},
		{name: "unknown_unchanged", err: errors.New("no direct media candidates"), want: "no direct media candidates"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeReasonError(tc.err, tc.fallback)
			if got == nil || got.Error() != tc.want {
				t.Fatalf("NormalizeReasonError = %v, want %q", got, tc.want)
			}
		})
	}
	if !errors.Is(NormalizeReasonError(context.Canceled, "locked"), context.Canceled) {
		t.Fatal("NormalizeReasonError broke errors.Is(context.Canceled)")
	}
}

func TestVideoFeedbackRequestKeyframeBypassesThrottle(t *testing.T) {
	f := newVideoFeedback("balanced")
	now := time.Now()
	f.receive([]rtcp.Packet{&rtcp.PictureLossIndication{}}, now)
	select {
	case <-f.keyframes:
	default:
		t.Fatal("expected initial keyframe")
	}
	// Within 250ms, RTCP PLI is throttled.
	f.receive([]rtcp.Packet{&rtcp.PictureLossIndication{}}, now.Add(10*time.Millisecond))
	if len(f.keyframes) != 0 {
		t.Fatal("expected RTCP PLI to be throttled")
	}
	// Connected callback bypasses and resets the throttle.
	f.requestKeyframe()
	select {
	case <-f.keyframes:
	default:
		t.Fatal("requestKeyframe did not enqueue unthrottled keyframe")
	}
	f.receive([]rtcp.Packet{&rtcp.PictureLossIndication{}}, now.Add(20*time.Millisecond))
	select {
	case <-f.keyframes:
	default:
		t.Fatal("requestKeyframe did not reset RTCP throttle")
	}

	v := videoObservation{requests: make(chan uint64, 1)}
	v.observe(now, false, true, f)
	<-f.keyframes
	v.observe(now.Add(100*time.Millisecond), false, true, f)
	if len(f.keyframes) != 0 {
		t.Fatal("expected observation keyframe throttle")
	}
	v.resetKeyframe()
	v.observe(now.Add(150*time.Millisecond), false, true, f)
	select {
	case <-f.keyframes:
	default:
		t.Fatal("resetKeyframe did not reset observation throttle")
	}
}

func TestLocalStreamCloseReasonAndCancelledAnswer(t *testing.T) {
	s := &localStream{}
	s.setCloseReason("bogus")
	if got := s.CloseReason(); got != "" {
		t.Fatalf("unexpected reason %q", got)
	}
	s.setCloseReason("locked")
	s.setCloseReason("sleeping")
	if got := s.CloseReason(); got != "locked" {
		t.Fatalf("CloseReason = %q, want locked", got)
	}

	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(client)
	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-done
	p, err := createMedia(Request{SDP: client.LocalDescription().SDP})
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.answer(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled answer = %v, want context.Canceled", err)
	}
}
