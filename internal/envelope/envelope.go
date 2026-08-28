package envelope

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	Version    = byte(0x01)
	HeaderSize = 24
	MaxPayload = 262144
)

const (
	TypHELLO_DAEMON        byte = 0x01
	TypHELLO_CLIENT        byte = 0x02
	TypPAIR_OPEN           byte = 0x03
	TypPAIR_ATTACH         byte = 0x04
	TypFWD                 byte = 0x05
	TypPAIR_CLOSE          byte = 0x06
	TypERROR               byte = 0x07
	TypPING                byte = 0x08
	TypPONG                byte = 0x09
	TypPAIR_ATTACHED       byte = 0x0B
	TypSESSION_ATTACH      byte = 0x0C
	TypSESSION_BOUND       byte = 0x0D
	TypDAEMON_REPLACED     byte = 0x0E
	TypSESSION_ESTABLISHED byte = 0x0F
)

type Frame struct {
	Version byte
	Typ     byte
	Flags   uint16
	RouteID [16]byte
	Payload []byte
}

func Encode(f Frame) []byte {
	out, err := EncodeChecked(f)
	if err != nil {
		panic(err)
	}
	return out
}

// EncodeChecked is the non-panicking encoder for frames crossing a transport
// boundary. Encode remains available for trusted, locally-built protocol
// constants and test fixtures.
func EncodeChecked(f Frame) ([]byte, error) {
	if f.Version == 0 {
		f.Version = Version
	}
	if err := Validate(f); err != nil {
		return nil, err
	}
	out := make([]byte, HeaderSize+len(f.Payload))
	out[0] = f.Version
	out[1] = f.Typ
	binary.BigEndian.PutUint16(out[2:4], f.Flags)
	binary.BigEndian.PutUint32(out[4:8], uint32(len(f.Payload)))
	copy(out[8:24], f.RouteID[:])
	copy(out[24:], f.Payload)
	return out, nil
}

func Decode(b []byte) (Frame, error) {
	if len(b) < HeaderSize {
		return Frame{}, errors.New("short frame")
	}
	n := binary.BigEndian.Uint32(b[4:8])
	if n > MaxPayload {
		return Frame{}, errors.New("length > 262144")
	}
	if int(n)+HeaderSize != len(b) {
		return Frame{}, errors.New("length mismatch")
	}
	var f Frame
	f.Version = b[0]
	f.Typ = b[1]
	f.Flags = binary.BigEndian.Uint16(b[2:4])
	copy(f.RouteID[:], b[8:24])
	f.Payload = append([]byte(nil), b[24:]...)
	if err := Validate(f); err != nil {
		return Frame{}, err
	}
	return f, nil
}

// Validate enforces the v1 envelope invariants before a frame is handled or
// written. In particular, bit 0 is reserved and all flags MUST be zero in v1.
func Validate(f Frame) error {
	if f.Version != Version {
		return fmt.Errorf("unsupported envelope version %d", f.Version)
	}
	if f.Flags != 0 {
		return fmt.Errorf("unsupported envelope flags 0x%04x", f.Flags)
	}
	if len(f.Payload) > MaxPayload {
		return fmt.Errorf("payload length %d exceeds %d", len(f.Payload), MaxPayload)
	}
	if !KnownType(f.Typ) {
		return fmt.Errorf("unknown envelope type 0x%02x", f.Typ)
	}
	return nil
}

func KnownType(typ byte) bool {
	switch typ {
	case TypHELLO_DAEMON, TypHELLO_CLIENT, TypPAIR_OPEN, TypPAIR_ATTACH,
		TypFWD, TypPAIR_CLOSE, TypERROR, TypPING, TypPONG,
		TypPAIR_ATTACHED, TypSESSION_ATTACH, TypSESSION_BOUND,
		TypDAEMON_REPLACED, TypSESSION_ESTABLISHED:
		return true
	default:
		return false
	}
}

func JSON(typ byte, routeID [16]byte, v any) Frame {
	p, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return Frame{Version: Version, Typ: typ, RouteID: routeID, Payload: p}
}

func WriteWS(w io.Writer, f Frame) error {
	b, err := EncodeChecked(f)
	if err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

type ErrorBody struct {
	Code    string `json:"code"`
	RouteID string `json:"route_id,omitempty"`
	PairRef string `json:"pair_ref,omitempty"`
	Message string `json:"message"`
}
