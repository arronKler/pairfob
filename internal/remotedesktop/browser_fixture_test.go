package remotedesktop

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

// The optional loss scenarios model a changed host frame missing at the viewer.
// Only the test card goes through the real H.264 sender.
type desktopFixtureSession struct {
	mu                        sync.Mutex
	end                       context.CancelFunc
	mode                      string
	observe, missing, refresh bool
	since                     time.Time
	stamp                     uint32
	sent                      bool
}

func (s *desktopFixtureSession) ping(observe, keyframe bool) StreamObservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	if observe && s.sent && !s.observe {
		s.observe = true
		s.since = time.Now()
	}
	if s.observe && s.mode != "idle" && time.Since(s.since) > 3*time.Second {
		s.missing = true
	}
	if keyframe && s.mode == "recover" && s.missing {
		s.refresh = true
		s.mode = "idle"
	}
	stamp := s.stamp
	if s.missing {
		stamp++
	}
	return StreamObservation{RTPTime: stamp, Healthy: s.sent}
}

func (s *desktopFixtureSession) video(peer *mediaPeer, frame []byte, pts uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.observe && !s.refresh {
		return nil
	}
	stamp, sent, err := peer.writeFrame(frame, pts)
	if sent {
		s.stamp, s.sent, s.refresh, s.missing = stamp, true, false, false
	}
	return err
}

// Run explicitly for the PWA QA scenes. Only a generated test card is ever sent.
func TestDesktopBrowserFixture(t *testing.T) {
	if os.Getenv("PAIRFOB_DESKTOP_BROWSER_QA") != "1" {
		t.Skip("interactive browser fixture")
	}
	frame, err := os.ReadFile("testdata/display.h264")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	sessions := map[string]*desktopFixtureSession{}
	serve := func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		u, err := url.Parse(origin)
		if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || !(u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost") {
			http.Error(w, "local QA origin required", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "POST" {
			http.Error(w, "POST required", 405)
			return
		}
		if r.URL.Path == "/close" || r.URL.Path == "/ping" {
			mu.Lock()
			session := sessions[r.URL.Query().Get("id")]
			mu.Unlock()
			if session == nil {
				http.Error(w, "session closed", 404)
			} else if r.URL.Path == "/close" {
				session.end()
				w.Write([]byte("{}"))
			} else {
				var args struct{ Observe, Keyframe bool }
				if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256)).Decode(&args) != nil {
					http.Error(w, "invalid ping", 400)
					return
				}
				json.NewEncoder(w).Encode(session.ping(args.Observe, args.Keyframe))
			}
			return
		}
		if r.URL.Path != "/open" {
			http.NotFound(w, r)
			return
		}
		var request Request
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 80<<10)).Decode(&request) != nil {
			http.Error(w, "invalid offer", 400)
			return
		}
		peer, err := createMedia(request)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		ctx, end := context.WithTimeout(context.Background(), 2*time.Minute)
		answer, err := peer.answer(ctx)
		if err != nil {
			end()
			peer.close()
			http.Error(w, err.Error(), 500)
			return
		}
		var nonce [16]byte
		rand.Read(nonce[:])
		id := hex.EncodeToString(nonce[:])
		mu.Lock()
		session := &desktopFixtureSession{end: end, mode: r.URL.Query().Get("mode")}
		sessions[id] = session
		mu.Unlock()
		go func() {
			defer end()
			defer peer.close()
			defer func() { mu.Lock(); delete(sessions, id); mu.Unlock() }()
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			var ticks uint64
			silence := []byte{0xf8, 0xff, 0xfe}
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					ticks++
					if ticks%5 == 0 && session.video(peer, frame, ticks*20000) != nil {
						return
					}
					if peer.audio != nil {
						if peer.audio.WriteSample(media.Sample{Data: silence, Duration: 20 * time.Millisecond}) != nil {
							return
						}
					}
				}
			}
		}()
		json.NewEncoder(w).Encode(map[string]string{"id": id, "display": "QA display", "sdp": answer})
	}
	server := &http.Server{Addr: "127.0.0.1:18846", Handler: http.HandlerFunc(serve), ReadHeaderTimeout: 5 * time.Second}
	t.Fatal(server.ListenAndServe())
}
