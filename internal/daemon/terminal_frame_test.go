package daemon

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/runtime"
)

const benchmarkTerminalID = "term_0123456789abcdef0123456789abcdef"

// The encoder before this optimization, retained as a byte-for-byte oracle
// and a reproducible performance baseline (4a380369).
func referenceTerminalFrame(id string, frame runtime.TerminalFrame, index, count int, data []byte) []byte {
	body, err := json.Marshal(map[string]any{
		"v": 1, "op": "TerminalFrame", "params": map[string]any{
			"terminal_id": id, "seq": fmt.Sprintf("%d", frame.Sequence),
			"width": frame.Width, "height": frame.Height, "full": frame.Full,
			"index": index, "count": count, "data": base64.StdEncoding.EncodeToString(data),
		},
	})
	if err != nil {
		panic(err)
	}
	return body
}

func TestTerminalFrameWireUnchanged(t *testing.T) {
	for _, size := range []int{0, 1, 2, 3, 256, terminalFrameChunk - 1, terminalFrameChunk, terminalFrameChunk + 1, maxTerminalFrameBytes} {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(i)
		}
		for _, full := range []bool{false, true} {
			frame := runtime.TerminalFrame{Sequence: ^uint64(0), Width: 320, Height: 160, Full: full, Data: data}
			parts := max(1, (size+terminalFrameChunk-1)/terminalFrameChunk)
			var buffer []byte
			for index := range parts {
				part := data[index*terminalFrameChunk : min((index+1)*terminalFrameChunk, size)]
				buffer = appendTerminalFrame(buffer[:0], benchmarkTerminalID, frame, index, parts, part)
				want := referenceTerminalFrame(benchmarkTerminalID, frame, index, parts, part)
				if !bytes.Equal(buffer, want) {
					t.Fatalf("wire changed: size=%d full=%v part=%d", size, full, index)
				}
				if len(buffer) > aead.MaxPlaintext {
					t.Fatalf("plaintext too large: %d", len(buffer))
				}
			}
		}
	}
}

func TestTerminalFrameEncryptedPartsOwnTheirBytes(t *testing.T) {
	link := newFailNthConn(0)
	engine, session, key := establishedSendSession(t, link)
	slot := &terminalSlot{id: benchmarkTerminalID}
	session.terminal = slot
	data := make([]byte, maxTerminalFrameBytes)
	for i := range data {
		data[i] = byte(i*31 + i/terminalFrameChunk)
	}
	frame := runtime.TerminalFrame{Sequence: 17, Width: 120, Height: 40, Full: true, Data: data}
	if delivered, failed := engine.sendTerminalFrame(session, slot, frame); !delivered || failed {
		t.Fatalf("delivered=%v transportFailed=%v", delivered, failed)
	}
	_, frames, _ := link.snapshot()
	parts := (len(data) + terminalFrameChunk - 1) / terminalFrameChunk
	if len(frames) != parts {
		t.Fatalf("got %d parts, want %d", len(frames), parts)
	}
	receiver := &aead.Direction{Key: key, Dir: aead.DirServer}
	// Decrypt only after every plaintext buffer reuse: earlier ciphertext must
	// remain valid, ordered, and identical to the previous wire representation.
	for index, encrypted := range frames {
		body, err := aead.Open(receiver, session.routeID, encrypted.Payload)
		if err != nil {
			t.Fatal(err)
		}
		part := data[index*terminalFrameChunk : min((index+1)*terminalFrameChunk, len(data))]
		if !bytes.Equal(body, referenceTerminalFrame(slot.id, frame, index, parts, part)) {
			t.Fatalf("encrypted part %d changed", index)
		}
	}
}

func BenchmarkTerminalFrameEncode(b *testing.B) {
	benchmarkTerminalFrame(b, false)
}

func BenchmarkTerminalFrameSeal(b *testing.B) {
	benchmarkTerminalFrame(b, true)
}

func benchmarkTerminalFrame(b *testing.B, seal bool) {
	for _, size := range []int{64, 4096, terminalFrameChunk, maxTerminalFrameBytes} {
		for _, optimized := range []bool{false, true} {
			name := "baseline"
			if optimized {
				name = "optimized"
			}
			b.Run(fmt.Sprintf("%d/%s", size, name), func(b *testing.B) {
				frame := runtime.TerminalFrame{Sequence: 123, Width: 120, Height: 40, Full: true, Data: bytes.Repeat([]byte("x"), size)}
				parts := max(1, (size+terminalFrameChunk-1)/terminalFrameChunk)
				direction := &aead.Direction{Key: make([]byte, 32), Dir: aead.DirServer}
				b.SetBytes(int64(size))
				b.ReportAllocs()
				b.ResetTimer()
				for b.Loop() {
					var body []byte
					if optimized {
						body = make([]byte, 0, 256+base64.StdEncoding.EncodedLen(min(size, terminalFrameChunk)))
					}
					for index := range parts {
						part := frame.Data[index*terminalFrameChunk : min((index+1)*terminalFrameChunk, size)]
						if optimized {
							body = appendTerminalFrame(body[:0], benchmarkTerminalID, frame, index, parts, part)
						} else {
							body = referenceTerminalFrame(benchmarkTerminalID, frame, index, parts, part)
						}
						if seal {
							if _, err := aead.Seal(direction, [16]byte{}, body); err != nil {
								b.Fatal(err)
							}
						}
					}
				}
			})
		}
	}
}
