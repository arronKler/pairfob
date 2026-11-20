// Standalone LAN measurement harness. The native source captures only its own test window.
package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

//go:embed viewer.html
var viewer []byte

//go:embed viewer.js
var script []byte

//go:embed observer.js
var observer []byte

func main() {
	addr := flag.String("listen", "127.0.0.1:18797", "HTTP(S) signaling address")
	probe := flag.String("probe", "", "native capture executable")
	cert := flag.String("cert", "", "optional TLS certificate")
	key := flag.String("key", "", "optional TLS key")
	mediaAddr := flag.String("media-listen", "", "optional LAN UDP and TCP media address")
	flag.Parse()
	api, cleanup, err := mediaAPI(*mediaAddr)
	if err != nil {
		log.Fatal(err)
	}
	defer cleanup()
	if _, err := os.Stat(*probe); err != nil {
		log.Fatal(err)
	}
	var busy atomic.Bool
	token := rand.Text()
	// A local operator can preserve a previously issued link across a restart.
	if old := os.Getenv("PAIRFOB_PROBE_TOKEN"); old != "" {
		if len(old) != len(token) || strings.Trim(old, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") != "" {
			log.Fatal("invalid probe token")
		}
		token = old
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Referrer-Policy", "no-referrer")
		log.Print("viewer: page requested")
		w.Write(viewer)
	})
	mux.HandleFunc("GET /viewer.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		w.Write(script)
	})
	mux.HandleFunc("GET /observer.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		w.Write(observer)
	})
	mux.HandleFunc("POST /offer", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			log.Print("offer: invalid or missing link token")
			http.Error(w, "需要本次启动链接", 403)
			return
		}
		var req struct {
			Offer webrtc.SessionDescription
			FPS   int
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&req); err != nil ||
			req.Offer.Type != webrtc.SDPTypeOffer || (req.FPS != 60 && req.FPS != 120) {
			http.Error(w, "invalid offer", 400)
			return
		}
		log.Printf("offer: authenticated, fps=%d", req.FPS)
		if !busy.CompareAndSwap(false, true) {
			http.Error(w, "已有测试连接，请先断开", 409)
			return
		}
		answer, err := negotiate(api, *probe, req.FPS, req.Offer, func() { busy.Store(false) })
		if err != nil {
			log.Print(err)
			http.Error(w, "协商失败", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(answer)
	})
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	scheme := "http"
	if *cert != "" || *key != "" {
		scheme = "https"
	}
	// Keep the requested DNS name so the printed TLS URL matches the certificate.
	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatal(err)
	}
	_, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s://%s/#%s\n", scheme, net.JoinHostPort(host, port), token)
	server := http.Server{Handler: mux, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second}
	if scheme == "https" {
		log.Fatal(server.ServeTLS(listener, *cert, *key))
	}
	log.Fatal(server.Serve(listener))
}

func negotiate(api *webrtc.API, probe string, fps int, offer webrtc.SessionDescription, release func()) (*webrtc.SessionDescription, error) {
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		release()
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	ready := make(chan *webrtc.DataChannel, 1)
	go func() {
		<-ctx.Done()
		pc.Close()
		release()
	}()
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("peer: %s", s)
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateDisconnected {
			cancel()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "probe" {
			cancel()
			return
		}
		dc.OnClose(cancel)
		dc.OnOpen(func() {
			select {
			case ready <- dc:
			default:
				cancel()
			}
		})
	})
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264,
		ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"}, "pattern", "desktop-probe")
	if err == nil {
		var sender *webrtc.RTPSender
		sender, err = pc.AddTrack(track)
		if err == nil {
			go func() {
				for {
					if _, _, e := sender.ReadRTCP(); e != nil {
						return
					}
				}
			}()
		}
	}
	if err == nil {
		err = pc.SetRemoteDescription(offer)
	}
	var answer webrtc.SessionDescription
	if err == nil {
		answer, err = pc.CreateAnswer(nil)
	}
	if err != nil {
		cancel()
		return nil, err
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		cancel()
		return nil, err
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		cancel()
		return nil, errors.New("ICE timeout")
	}
	go func() {
		defer cancel()
		select {
		case dc := <-ready:
			log.Print("data channel: open")
			if e := streamProbe(ctx, probe, fps, dc, track); e != nil && ctx.Err() == nil {
				log.Print(e)
				dc.SendText("error: " + e.Error())
			}
		case <-time.After(25 * time.Second):
			log.Print("data channel: open timed out")
		case <-ctx.Done():
		}
	}()
	return pc.LocalDescription(), nil
}

func streamProbe(ctx context.Context, probe string, fps int, dc *webrtc.DataChannel, track *webrtc.TrackLocalStaticRTP) error {
	childCtx, stop := context.WithCancel(ctx)
	defer stop()
	cmd := exec.CommandContext(childCtx, probe, fmt.Sprint(fps))
	cmd.Stderr = os.Stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer in.Close()
	if err = cmd.Start(); err != nil {
		return err
	}
	defer func() { stop(); cmd.Wait() }()
	var sequence uint32
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString && string(m.Data) == "flip" {
			sequence++
			fmt.Fprintln(in, sequence)
			dc.SendText(fmt.Sprintf("ack %d", sequence))
		}
		if m.IsString && string(m.Data) == "stop" {
			stop()
		}
	})
	dc.SendText("starting")
	packetizer := rtp.NewPacketizer(1200, 0, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)
	for {
		var header [16]byte
		if _, err = io.ReadFull(out, header[:]); err != nil {
			return fmt.Errorf("capture ended (%s); check host output", strings.TrimSpace(err.Error()))
		}
		size := binary.BigEndian.Uint32(header[:4])
		stamp := binary.BigEndian.Uint64(header[4:12])
		id := binary.BigEndian.Uint32(header[12:])
		var timing [3]uint32
		if id != 0 {
			if err = binary.Read(out, binary.BigEndian, &timing); err != nil {
				return err
			}
		}
		if size == 0 || size > 8<<20 {
			return errors.New("invalid encoded frame")
		}
		frame := make([]byte, size)
		if _, err = io.ReadFull(out, frame); err != nil {
			return err
		}
		// Use the capture PTS of this frame even when the compositor skips updates.
		var timestamp uint32
		for _, packet := range packetizer.Packetize(frame, 0) {
			packet.Timestamp += uint32(stamp * 9 / 100)
			timestamp = packet.Timestamp
			if err = track.WriteRTP(packet); err != nil {
				return err
			}
		}
		if id != 0 {
			dc.SendText(fmt.Sprintf("frame %d %d %d %d %d", id, timestamp, timing[0], timing[1], timing[2]))
		}
	}
}
