// Package hkdfk is Pairfob HKDF-SHA256 (§4.2.1 / RFC 5869).
package hkdfk

import (
	"crypto/hmac"
	"crypto/sha256"
	"io"

	"golang.org/x/crypto/hkdf"
)

var Zeros32 = make([]byte, 32)

// HKDF is Extract-then-Expand. salt nil or empty is HashLen zeros (RFC 5869).
func HKDF(ikm, salt, info []byte, L int) []byte {
	if salt == nil {
		salt = Zeros32
	}
	r := hkdf.New(sha256.New, ikm, salt, info)
	out := make([]byte, L)
	if _, err := io.ReadFull(r, out); err != nil {
		panic(err)
	}
	return out
}

func HMACSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}
