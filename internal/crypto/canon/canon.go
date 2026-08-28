// Package canon implements Pairfob §3.1.1 canonical encodings.
package canon

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"strings"
)

// EncStr is RFC 9383-style length prefix: uint64_le(len) || bytes.
func EncStr(s string) []byte {
	b := []byte(s)
	out := make([]byte, 8+len(b))
	binary.LittleEndian.PutUint64(out[:8], uint64(len(b)))
	copy(out[8:], b)
	return out
}

func Concat(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func U64BE(n uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	return b[:]
}

func PairRefHex(pairRef []byte) string {
	if len(pairRef) != 16 {
		panic("pair_ref must be 16 bytes")
	}
	return hex.EncodeToString(pairRef) // lowercase
}

func NormalizeCrockford(s string) string {
	s = strings.ToUpper(s)
	s = strings.Map(func(r rune) rune {
		switch r {
		case ' ', '-', '/', '_':
			return -1
		case 'I', 'L':
			return '1'
		case 'O':
			return '0'
		case 'U':
			return 'V'
		default:
			return r
		}
	}, s)
	return s
}

// Fingerprint16 is b64url(SHA-256(raw Ed25519 pk)[0:16]) without padding.
func Fingerprint16(rawPK []byte) string {
	if len(rawPK) != 32 {
		panic("ed25519 pk must be 32 bytes")
	}
	sum := sha256.Sum256(rawPK)
	return B64URL(sum[:16])
}

func B64URL(b []byte) string {
	const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	// std encoding without pad
	n := (len(b)*8 + 5) / 6
	out := make([]byte, n)
	var acc, bits int
	j := 0
	for _, c := range b {
		acc = (acc << 8) | int(c)
		bits += 8
		for bits >= 6 {
			bits -= 6
			out[j] = alph[(acc>>bits)&63]
			j++
		}
	}
	if bits > 0 {
		out[j] = alph[(acc<<(6-bits))&63]
		j++
	}
	return string(out[:j])
}

func MustDecodeB64URL(s string) []byte {
	b, err := DecodeB64URL(s)
	if err != nil {
		panic(err)
	}
	return b
}

func DecodeB64URL(s string) ([]byte, error) {
	const alph = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	// Raw base64url can only have 0, 2, or 3 characters in its final
	// quantum. A one-character tail cannot encode a complete byte.
	if len(s)%4 == 1 {
		return nil, errB64
	}
	var rev [256]int
	for i := range rev {
		rev[i] = -1
	}
	for i := 0; i < 64; i++ {
		rev[alph[i]] = i
	}
	var acc, bits int
	out := make([]byte, 0, len(s)*6/8)
	for i := 0; i < len(s); i++ {
		v := rev[s[i]]
		if v < 0 {
			return nil, errB64
		}
		acc = (acc << 6) | v
		bits += 6
		if bits >= 8 {
			bits -= 8
			out = append(out, byte((acc>>bits)&0xFF))
		}
	}
	// Reject alternate spellings whose unused low bits are non-zero. This
	// keeps protocol transcript inputs canonical instead of accepting several
	// strings for the same byte sequence.
	if bits > 0 && acc&((1<<bits)-1) != 0 {
		return nil, errB64
	}
	return out, nil
}

type b64err string

func (e b64err) Error() string { return string(e) }

const errB64 b64err = "invalid b64url"
