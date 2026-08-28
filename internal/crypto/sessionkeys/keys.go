package sessionkeys

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"

	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/hkdfk"
	"pairfob/internal/crypto/pgpwords"
)

func PairingKeys(kShared []byte) (c2s, s2c []byte) {
	root := hkdfk.HKDF(kShared, hkdfk.Zeros32, []byte("pairfob-v1/pair-root"), 32)
	c2s = hkdfk.HKDF(root, hkdfk.Zeros32, []byte("pairfob-v1/pair-c2s"), 32)
	s2c = hkdfk.HKDF(root, hkdfk.Zeros32, []byte("pairfob-v1/pair-s2c"), 32)
	return
}

func SessionKeys(dh, devicePSK []byte) (c2s, s2c []byte) {
	ikm := append(append([]byte{}, dh...), devicePSK...)
	root := hkdfk.HKDF(ikm, hkdfk.Zeros32, []byte("pairfob-v1/sess-root"), 32)
	c2s = hkdfk.HKDF(root, hkdfk.Zeros32, []byte("pairfob-v1/sess-c2s"), 32)
	s2c = hkdfk.HKDF(root, hkdfk.Zeros32, []byte("pairfob-v1/sess-s2c"), 32)
	return
}

func SAS(kShared []byte) string {
	key := hkdfk.HKDF(kShared, hkdfk.Zeros32, []byte("pairfob-v1/sas"), 4)
	return pgpwords.Even[key[0]] + "-" + pgpwords.Odd[key[1]]
}

type Hello1 struct {
	V         int    `json:"v"`
	Op        string `json:"op"`
	DeviceID  string `json:"device_id"`
	DaemonID  string `json:"daemon_id"`
	EphX25519 string `json:"eph_x25519"`
	Nonce     string `json:"nonce"`
}

type Hello2 struct {
	V         int    `json:"v"`
	Op        string `json:"op"`
	OK        bool   `json:"ok"`
	EphX25519 string `json:"eph_x25519,omitempty"`
	TS        int64  `json:"ts,omitempty"`
	ProofD    string `json:"proof_d,omitempty"`
	SigD      string `json:"sig_d,omitempty"`
	Error     *struct {
		Code string `json:"code"`
	} `json:"error,omitempty"`
}

type Hello3 struct {
	V      int    `json:"v"`
	Op     string `json:"op"`
	ProofP string `json:"proof_p"`
}

func TranscriptD(daemonID, deviceID string, ephP, ephD, nonce []byte, ts int64, routeID [16]byte) []byte {
	return canon.Concat(
		canon.EncStr("pairfob-v1/hello-d"),
		canon.EncStr(daemonID),
		canon.EncStr(deviceID),
		ephP, ephD, nonce,
		canon.U64BE(uint64(ts)),
		routeID[:],
	)
}

func TranscriptP(td []byte) []byte {
	return canon.Concat(canon.EncStr("pairfob-v1/hello-p"), td)
}

func Proof(psk, transcript []byte) []byte {
	return hkdfk.HMACSHA256(psk, transcript)
}

func Sign(sk ed25519.PrivateKey, transcript []byte) []byte {
	return ed25519.Sign(sk, transcript)
}

func VerifySig(pk ed25519.PublicKey, transcript, sig []byte) bool {
	return ed25519.Verify(pk, transcript, sig)
}

func MustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func HMACEqual(a, b []byte) bool {
	return hmac.Equal(a, b)
}

func SHA256(b []byte) [32]byte { return sha256.Sum256(b) }
