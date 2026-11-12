package daemon

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

// Model the production 128-frame relay pipe draining at 4 ms per envelope. Both variants transfer the
// same 4 MiB terminal frame and authenticated Ping; only lock/admission behavior
// differs. This measures control latency during bulk output, not internet speed.
type pacedTerminalConn struct {
	frames  chan envelope.Frame
	entered chan struct{}
	once    sync.Once
}

func (c *pacedTerminalConn) Send(frame envelope.Frame) error {
	c.once.Do(func() { close(c.entered) })
	time.Sleep(4 * time.Millisecond)
	c.frames <- frame
	return nil
}
func (*pacedTerminalConn) Close() {}

func BenchmarkTerminalContention(b *testing.B) {
	for _, baseline := range []bool{true, false} {
		name := "optimized"
		if baseline {
			name = "baseline"
		}
		b.Run(name, func(b *testing.B) {
			var control time.Duration
			b.SetBytes(maxTerminalFrameBytes)
			b.ReportAllocs()
			for range b.N {
				link := &pacedTerminalConn{frames: make(chan envelope.Frame, 64), entered: make(chan struct{})}
				incoming, peer := mux.NewPipePair(8)
				outgoing, relay := mux.NewPipePair(128)
				relayDone := make(chan struct{})
				go func() {
					defer close(relayDone)
					for {
						f, ok := relay.Recv()
						if !ok {
							return
						}
						_ = link.Send(f)
					}
				}()
				e := NewEngine(nil, incoming, runtime.NewFake())
				key := make([]byte, 32)
				s := &sess{routeID: [16]byte{1}, state: "established", link: outgoing,
					c2s:      &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirClient},
					s2c:      &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer},
					rpcQueue: make(chan rpcRequest, 32), pingQueue: make(chan rpcRequest, 4), rpcStop: make(chan struct{})}
				e.sessions[s.routeID] = s
				slot := &terminalSlot{id: benchmarkTerminalID}
				s.terminal = slot
				frame := runtime.TerminalFrame{Sequence: 1, Width: 120, Height: 40, Data: make([]byte, maxTerminalFrameBytes), Full: true}
				sent := make(chan bool, 1)
				go func() {
					if baseline {
						sent <- referenceLockedTerminalSend(e, s, slot, frame)
					} else {
						ok, _ := e.sendTerminalFrame(s, slot, frame)
						sent <- ok
					}
				}()
				healthDone := make(chan struct{})
				go func() { defer close(healthDone); e.runSessionPing(s) }()
				ingressDone := make(chan struct{})
				go func() {
					defer close(ingressDone)
					f, _ := incoming.Recv()
					// Before this change ingress waited behind the whole outgoing frame.
					if baseline {
						s.sendMu.Lock()
						s.sendMu.Unlock()
					}
					e.Handle(f)
				}()
				<-link.entered
				start := time.Now()
				payload, err := aead.Seal(&aead.Direction{Key: key, Dir: aead.DirClient}, s.routeID, []byte(`{"v":1,"id":"control","op":"Ping","params":{"t_ms":1}}`))
				if err != nil {
					b.Fatal(err)
				}
				if err = peer.Send(envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload}); err != nil {
					b.Fatal(err)
				}
				rx := &aead.Direction{Key: key, Dir: aead.DirServer}
				parts := (len(frame.Data) + terminalFrameChunk - 1) / terminalFrameChunk
				sawControl := false
				for range parts + 1 {
					var encrypted envelope.Frame
					select {
					case encrypted = <-link.frames:
					case <-time.After(10 * time.Second):
						b.Fatal("stream stalled")
					}
					body, err := aead.Open(rx, s.routeID, encrypted.Payload)
					if err != nil {
						b.Fatal(err)
					}
					var reply struct {
						ID string `json:"id"`
					}
					if err = json.Unmarshal(body, &reply); err != nil {
						b.Fatal(err)
					}
					if reply.ID == "control" {
						control += time.Since(start)
						sawControl = true
					}
				}
				if !sawControl || !<-sent {
					b.Fatal("lost output")
				}
				<-ingressDone
				stopSessionRPC(s)
				<-healthDone
				incoming.Close()
				peer.Close()
				relay.Close()
				<-relayDone
				outgoing.Close()
			}
			b.ReportMetric(float64(control.Microseconds())/float64(b.N)/1000, "control-ms/op")
		})
	}
}

// Pre-change scheduling, with the same optimized encoder and same wire bytes.
func referenceLockedTerminalSend(e *Engine, s *sess, slot *terminalSlot, frame runtime.TerminalFrame) bool {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	parts := (len(frame.Data) + terminalFrameChunk - 1) / terminalFrameChunk
	var body []byte
	for index := range parts {
		start := index * terminalFrameChunk
		body = appendTerminalFrame(body[:0], slot.id, frame, index, parts, frame.Data[start:min(start+terminalFrameChunk, len(frame.Data))])
		payload, err := aead.Seal(s.s2c, s.routeID, body)
		if err != nil {
			return false
		}
		if e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload}) != nil {
			return false
		}
	}
	return true
}
