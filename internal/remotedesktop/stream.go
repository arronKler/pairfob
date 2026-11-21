package remotedesktop

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type localStream struct {
	peer        *mediaPeer
	ctx         context.Context
	input       chan Event
	done        chan struct{}
	reasonMu    sync.Mutex
	closeReason string
}

func (s *localStream) Done() <-chan struct{} { return s.done }

func (s *localStream) setCloseReason(reason string) {
	if !IsKnownReason(reason) {
		return
	}
	s.reasonMu.Lock()
	if s.closeReason == "" {
		s.closeReason = reason
	}
	s.reasonMu.Unlock()
}

func (s *localStream) CloseReason() string {
	s.reasonMu.Lock()
	defer s.reasonMu.Unlock()
	return s.closeReason
}

func parseStopReason(r io.Reader) string {
	br := bufio.NewReaderSize(r, 4096)
	prefix := []byte("PF_STOP_REASON:")
	var reason string
	for {
		line, isPrefix, err := br.ReadLine()
		if len(line) > 0 && !isPrefix && bytes.HasPrefix(line, prefix) {
			code := strings.TrimSpace(string(line[len(prefix):]))
			if IsKnownReason(code) && reason == "" {
				reason = code
			}
		}
		for isPrefix && err == nil {
			_, isPrefix, err = br.ReadLine()
		}
		if err != nil {
			return reason
		}
	}
}
func (s *localStream) Observe(observe, keyframe bool) StreamObservation {
	if s.ctx.Err() != nil {
		return StreamObservation{}
	}
	return s.peer.observations.observe(time.Now(), observe, keyframe, s.peer.feedback)
}

func (s *localStream) Input(e Event) error {
	if !e.Valid() || s.ctx.Err() != nil {
		return ErrUnavailable
	}
	select {
	case s.input <- e:
		return nil
	default:
		return errors.New("input queue full")
	}
}

func (h LocalHost) Open(parent context.Context, label string, req Request) (Stream, Result, error) {
	var result Result
	p := h.Policy()
	if !p.View || (req.Control && !p.Control) {
		return nil, result, ErrUnavailable
	}
	peer, err := createMedia(req)
	if err != nil {
		return nil, result, err
	}
	ctx, cancel := context.WithCancel(parent)
	exe, err := os.Executable()
	if err != nil {
		cancel()
		peer.close()
		return nil, result, err
	}
	mode, sound := "view", "silent"
	if req.Control {
		mode = "control"
	}
	if req.Audio {
		sound = "audio"
	}
	cmd := exec.CommandContext(ctx, exe, "__desktop_host", label, mode, req.Quality, sound, p.Display)
	in, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		peer.close()
		return nil, result, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		peer.close()
		in.Close()
		return nil, result, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		peer.close()
		in.Close()
		out.Close()
		return nil, result, err
	}
	// EOF lets the helper release held buttons before forced shutdown.
	cmd.Cancel = func() error { return in.Close() }
	cmd.WaitDelay = time.Second
	if err = cmd.Start(); err != nil {
		cancel()
		peer.close()
		in.Close()
		out.Close()
		stderr.Close()
		return nil, result, err
	}
	s := &localStream{peer: peer, ctx: ctx, input: make(chan Event, 32), done: make(chan struct{})}
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		if code := parseStopReason(stderr); code != "" {
			s.setCloseReason(code)
		}
	}()
	ready := make(chan error, 1)
	connected := make(chan struct{})
	var once sync.Once
	peer.pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		switch st {
		case webrtc.PeerConnectionStateConnected:
			once.Do(func() {
				close(connected)
				peer.observations.resetKeyframe()
				peer.feedback.requestKeyframe()
			})
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateDisconnected:
			cancel()
		}
	})
	go func() {
		<-ctx.Done()
		in.Close()
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		select {
		case <-s.done:
		case <-timer.C:
			cmd.Process.Kill()
		}
	}()
	go func() {
		defer close(s.done)
		defer peer.close()
		reader := bufio.NewReader(out)
		status, err := reader.ReadSlice('\n')
		var meta struct {
			Display string
			Error   string
		}
		if err == nil {
			err = json.Unmarshal(status, &meta)
		}
		if err == nil && meta.Display == "" {
			if meta.Error == "" {
				meta.Error = "screen capture failed"
			}
			s.setCloseReason(ClassifyReason(meta.Error))
			err = errors.New(meta.Error)
		}
		if err == nil {
			result.Display = meta.Display
			result.Control = req.Control
			result.Audio = req.Audio
		}
		ready <- err
		if err == nil {
			pumpMedia(reader, peer, connected)
		}
		cancel()
		out.Close()
		<-stderrDone
		cmd.Wait()
	}()
	go func() {
		enc := json.NewEncoder(in)
		for {
			var command any
			select {
			case <-ctx.Done():
				return
			case token := <-peer.observations.requests:
				command = map[string]uint64{"observe": token}
			case <-peer.feedback.keyframes:
				command = map[string]bool{"keyframe": true}
			case rate := <-peer.feedback.rates:
				command = map[string]int{"bitrate": rate}
			case e := <-s.input:
				if ctx.Err() != nil {
					return
				}
				command = e
			}
			if enc.Encode(command) != nil {
				cancel()
				return
			}
		}
	}()
	type answerResult struct {
		sdp string
		err error
	}
	answerCh := make(chan answerResult, 1)
	go func() {
		sdp, err := peer.answer(ctx)
		answerCh <- answerResult{sdp: sdp, err: err}
	}()
	var firstErr error
	var ans answerResult
	readyDone, answerDone := false, false
	for !readyDone || !answerDone {
		select {
		case err := <-ready:
			readyDone = true
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				cancel()
			}
		case a := <-answerCh:
			ans = a
			answerDone = true
			if a.err != nil {
				if firstErr == nil {
					firstErr = a.err
				}
				cancel()
			}
		}
	}
	if firstErr != nil || ctx.Err() != nil {
		cancel()
		<-s.done
		if firstErr == nil {
			firstErr = ctx.Err()
		}
		return nil, Result{}, NormalizeReasonError(firstErr, s.CloseReason())
	}
	result.SDP = ans.sdp
	return s, result, nil
}

func pumpMedia(r io.Reader, p *mediaPeer, connected <-chan struct{}) {
	for {
		var hdr [13]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			return
		}
		n := binary.BigEndian.Uint32(hdr[1:5])
		if n == 0 || n > 8<<20 {
			return
		}
		b := make([]byte, n)
		if _, err := io.ReadFull(r, b); err != nil {
			return
		}
		select {
		case <-connected:
		default:
			continue
		}
		pts := binary.BigEndian.Uint64(hdr[5:])
		switch hdr[0] {
		case 1:
			if p.writeVideo(b, pts) != nil {
				return
			}
		case 3: // display revision, observation query token and native capture age
			if len(b) != 16 {
				return
			}
			p.observations.capture(pts, binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:]))
		case 4: // encoded video with revision and encoder duration
			if len(b) <= 16 {
				return
			}
			stamp, sent, err := p.writeFrame(b[16:], pts)
			if err != nil {
				return
			}
			if sent {
				p.observations.sent(binary.BigEndian.Uint64(b[:8]), stamp, binary.BigEndian.Uint64(b[8:16]))
			}
		case 2:
			if p.audio == nil || p.audio.WriteSample(media.Sample{Data: b, Duration: 20 * time.Millisecond}) != nil {
				return
			}
		default:
			return
		}
	}
}
