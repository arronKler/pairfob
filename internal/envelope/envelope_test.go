package envelope

import (
	"encoding/binary"
	"testing"
)

func TestDecodeRejectsNonV1EnvelopeFields(t *testing.T) {
	valid := Encode(JSON(TypPING, [16]byte{}, map[string]any{"v": 1}))
	tests := []struct {
		name   string
		mutate func([]byte)
	}{
		{name: "version", mutate: func(b []byte) { b[0] = 2 }},
		{name: "flags", mutate: func(b []byte) { binary.BigEndian.PutUint16(b[2:4], 1) }},
		{name: "unknown type", mutate: func(b []byte) { b[1] = 0xff }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			wire := append([]byte(nil), valid...)
			tt.mutate(wire)
			if _, err := Decode(wire); err == nil {
				t.Fatal("Decode accepted an invalid v1 envelope")
			}
		})
	}
}

func TestEncodeCheckedReturnsOversizeError(t *testing.T) {
	_, err := EncodeChecked(Frame{Version: Version, Typ: TypFWD, Payload: make([]byte, MaxPayload+1)})
	if err == nil {
		t.Fatal("EncodeChecked accepted an oversized payload")
	}
}
