package remotedesktop

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"pairfob/internal/directice"
)

func validateOffer(req Request) error {
	var offer sdp.SessionDescription
	if err := offer.Unmarshal([]byte(req.SDP)); err != nil {
		return errors.New("invalid media offer")
	}
	media := map[string]int{}
	check := func(attrs []sdp.Attribute) bool {
		for _, a := range attrs {
			switch a.Key {
			case "candidate":
				c, err := ice.UnmarshalCandidate(a.Value)
				if err != nil || c.Type() == ice.CandidateTypeRelay {
					return false
				}
			case "sendonly", "sendrecv", "inactive":
				return false
			}
		}
		return true
	}
	if !check(offer.Attributes) {
		return errors.New("desktop requires direct receive-only media")
	}
	for _, m := range offer.MediaDescriptions {
		media[m.MediaName.Media]++
		if _, ok := m.Attribute("recvonly"); !ok || !check(m.Attributes) {
			return errors.New("desktop requires direct receive-only media")
		}
	}
	if media["video"] != 1 || (req.Audio && (len(media) != 2 || media["audio"] != 1)) || (!req.Audio && len(media) != 1) {
		return errors.New("unexpected media tracks")
	}
	return nil
}

type mediaPeer struct {
	pc           *webrtc.PeerConnection
	video        *webrtc.TrackLocalStaticRTP
	audio        *webrtc.TrackLocalStaticSample
	packetizer   rtp.Packetizer
	tcp          ice.TCPMux
	feedback     *videoFeedback
	observations videoObservation
}

func (p *mediaPeer) close() { p.pc.Close(); p.tcp.Close() }

func createMedia(req Request) (*mediaPeer, error) {
	if err := validateOffer(req); err != nil {
		return nil, err
	}
	tcp, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, err
	}
	mux := webrtc.NewICETCPMux(nil, tcp, 16)
	var settings webrtc.SettingEngine
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6, webrtc.NetworkTypeTCP4, webrtc.NetworkTypeTCP6})
	settings.SetICETCPMux(mux)
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}})
	if err != nil {
		mux.Close()
		return nil, err
	}
	p := &mediaPeer{pc: pc, tcp: mux, feedback: newVideoFeedback(req.Quality)}
	p.observations.requests = make(chan uint64, 1)
	if err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: req.SDP}); err != nil {
		p.close()
		return nil, err
	}
	p.packetizer = rtp.NewPacketizer(1200, 0, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)
	videoCodec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}
	p.video, err = webrtc.NewTrackLocalStaticRTP(videoCodec, "screen", "desktop")
	if err == nil {
		err = p.addTrack(p.video)
	}
	if err == nil && req.Audio {
		audioCodec := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1;stereo=1"}
		p.audio, err = webrtc.NewTrackLocalStaticSample(audioCodec, "system", "desktop")
		if err == nil {
			err = p.addTrack(p.audio)
		}
	}
	if err != nil {
		p.close()
		return nil, err
	}
	return p, nil
}

func (p *mediaPeer) addTrack(track webrtc.TrackLocal) error {
	sender, err := p.pc.AddTrack(track)
	if err != nil {
		return err
	}
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			if track.Kind() == webrtc.RTPCodecTypeVideo {
				p.feedback.receive(packets, time.Now())
			}
		}
	}()
	return nil
}

func (p *mediaPeer) writeVideo(data []byte, ptsMicros uint64) error {
	_, _, err := p.writeFrame(data, ptsMicros)
	return err
}

func (p *mediaPeer) writeFrame(data []byte, ptsMicros uint64) (uint32, bool, error) {
	// Packetization adds a random initial offset. Report the same timestamp
	// the receiver sees, only after the complete access unit was accepted.
	for _, packet := range p.packetizer.Packetize(data, 0) {
		packet.Timestamp += uint32(ptsMicros * 9 / 100)
		if err := p.video.WriteRTP(packet); err != nil {
			return 0, false, err
		}
		if packet.Marker {
			return packet.Timestamp, true, nil
		}
	}
	return 0, false, nil
}

func (p *mediaPeer) answer(ctx context.Context) (string, error) {
	a, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	var desc sdp.SessionDescription
	if err = desc.Unmarshal([]byte(a.SDP)); err != nil {
		return "", err
	}
	for _, m := range desc.MediaDescriptions {
		_, active := m.Attribute("sendonly")
		if !active || m.MediaName.Port.Value == 0 {
			return "", errors.New("browser lacks a compatible desktop codec")
		}
	}
	if err := directice.SetLocalAnswer(ctx, p.pc, a); err != nil {
		return "", err
	}
	answer := p.pc.LocalDescription().SDP
	if !strings.Contains(answer, "a=candidate:") {
		return "", errors.New("no direct media candidates")
	}
	return answer, nil
}
