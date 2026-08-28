// Package aead implements Pairfob FWD AEAD: ChaCha20-Poly1305, 12-byte nonce on wire, 21-byte AAD.
package aead

import (
	"encoding/binary"
	"errors"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	MaxPlaintext = 262116
	MaxPayload   = 262144 // nonce(12)+pt+tag(16)
	DirClient    = byte('c')
	DirServer    = byte('s')
)

var ErrTooLarge = errors.New("plaintext exceeds 262116")
var ErrSeq = errors.New("aead seq mismatch")
var ErrOpen = errors.New("aead open failed")

type Direction struct {
	Key []byte
	Seq uint64
	Dir byte
}

func Seal(d *Direction, routeID [16]byte, plaintext []byte) ([]byte, error) {
	if len(plaintext) > MaxPlaintext {
		return nil, ErrTooLarge
	}
	aead, err := chacha20poly1305.New(d.Key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 12)
	binary.BigEndian.PutUint64(nonce[4:], d.Seq)
	aad := AAD(0x01, 0x05, 0, routeID, d.Dir)
	ct := aead.Seal(nil, nonce, plaintext, aad)
	out := append(nonce, ct...)
	d.Seq++
	return out, nil
}

func Open(d *Direction, routeID [16]byte, payload []byte) ([]byte, error) {
	if len(payload) < 12+16 {
		return nil, ErrOpen
	}
	nonce, rest := payload[:12], payload[12:]
	got := binary.BigEndian.Uint64(nonce[4:])
	if got != d.Seq {
		return nil, ErrSeq
	}
	if nonce[0]|nonce[1]|nonce[2]|nonce[3] != 0 {
		return nil, ErrSeq
	}
	aead, err := chacha20poly1305.New(d.Key)
	if err != nil {
		return nil, err
	}
	aad := AAD(0x01, 0x05, 0, routeID, d.Dir)
	pt, err := aead.Open(nil, nonce, rest, aad)
	if err != nil {
		return nil, ErrOpen
	}
	d.Seq++
	return pt, nil
}

func AAD(version, typ byte, flags uint16, routeID [16]byte, dir byte) []byte {
	aad := make([]byte, 21)
	aad[0] = version
	aad[1] = typ
	binary.BigEndian.PutUint16(aad[2:4], flags)
	copy(aad[4:20], routeID[:])
	aad[20] = dir
	return aad
}
