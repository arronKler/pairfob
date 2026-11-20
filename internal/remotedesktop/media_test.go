package remotedesktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

func TestDesktopDirectMedia(t *testing.T) {
	// Exercise SDP, real ICE/DTLS and both RTP tracks over local sockets.
	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	received := make(chan string, 2)
	videoTimes := make(chan uint32, 4)
	videoSource := make(chan uint32, 1)
	client.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		packet, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		received <- track.Codec().MimeType
		if track.Kind() == webrtc.RTPCodecTypeVideo {
			videoSource <- uint32(track.SSRC())
			videoTimes <- packet.Timestamp
			for i := 0; i < 3; i++ {
				packet, _, err = track.ReadRTP()
				if err != nil {
					return
				}
				videoTimes <- packet.Timestamp
			}
		}
	})
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := client.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
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
	req := Request{SDP: client.LocalDescription().SDP, Audio: true}
	for _, bad := range []string{strings.ReplaceAll(req.SDP, "typ host", "typ relay"), strings.ReplaceAll(req.SDP, "a=recvonly", "a=sendrecv")} {
		if validateOffer(Request{SDP: bad, Audio: true}) == nil {
			t.Fatal("invalid offer accepted")
		}
	}
	p, err := createMedia(req)
	if err != nil {
		t.Fatal(err)
	}
	defer p.close()
	connected := make(chan struct{})
	p.pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			select {
			case <-connected:
			default:
				close(connected)
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	answer, err := p.answer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = client.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-ctx.Done():
		t.Fatal("peer did not connect")
	}
	var records bytes.Buffer
	for _, stamp := range []uint64{0, 500000, 516000, 532000} {
		for j, data := range [][]byte{{0, 0, 0, 1, 0x65, 0x88, 0x41}, {0xf8, 0xff, 0xfe}} {
			kind := byte(j + 1)
			if j == 0 {
				kind = 4
				var meta [16]byte
				binary.BigEndian.PutUint64(meta[:8], stamp+1)
				binary.BigEndian.PutUint64(meta[8:], 2500)
				data = append(meta[:], data...)
			}
			records.WriteByte(kind)
			binary.Write(&records, binary.BigEndian, uint32(len(data)))
			binary.Write(&records, binary.BigEndian, stamp)
			records.Write(data)
		}
	}
	pumpMedia(&records, p, connected)
	got := map[string]bool{}
	for len(got) < 2 {
		select {
		case codec := <-received:
			got[codec] = true
		case <-ctx.Done():
			t.Fatalf("received %v", got)
		}
	}
	if !got[webrtc.MimeTypeH264] || !got[webrtc.MimeTypeOpus] {
		t.Fatal(got)
	}
	var stamps [4]uint32
	for i := range stamps {
		select {
		case stamps[i] = <-videoTimes:
		case <-ctx.Done():
			t.Fatal("missing video frame")
		}
	}
	if stamps[1]-stamps[0] != 45000 || stamps[2]-stamps[1] != 1440 {
		t.Fatalf("capture timing changed after idle: %v", stamps)
	}

	sample := p.observations.observe(time.Now(), false, false, p.feedback)
	if sample.RTPTime != stamps[3] || sample.EncodeMS != 2.5 || sample.Healthy {
		t.Fatalf("observation %+v does not identify last RTP packet %d", sample, stamps[3])
	}
	source := <-videoSource
	if err := client.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: source},
		&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: source, FractionLost: 40}}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.feedback.keyframes:
	case <-ctx.Done():
		t.Fatal("receiver keyframe request lost")
	}
	select {
	case rate := <-p.feedback.rates:
		if rate >= 8000000 {
			t.Fatal("rate after loss", rate)
		}
	case <-ctx.Done():
		t.Fatal("receiver loss report lost")
	}
}
