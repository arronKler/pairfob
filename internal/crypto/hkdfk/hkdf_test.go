package hkdfk

import (
	"encoding/hex"
	"testing"

	"pairfob/internal/crypto/testvec"
)

func TestFrozenHKDFInfoStrings(t *testing.T) {
	v := testvec.Load(t)
	ikm := testvec.Hex(t, v.HKDFSAS4IKM)
	got := HKDF(ikm, Zeros32, []byte("pairfob-v1/sas"), 4)
	if hex.EncodeToString(got) != v.HKDFSAS4 {
		t.Fatalf("sas L=4 %x vs %s", got, v.HKDFSAS4)
	}

	kShared := testvec.Hex(t, v.KShared)
	root := HKDF(kShared, Zeros32, []byte("pairfob-v1/pair-root"), 32)
	c2s := HKDF(root, Zeros32, []byte("pairfob-v1/pair-c2s"), 32)
	s2c := HKDF(root, Zeros32, []byte("pairfob-v1/pair-s2c"), 32)
	if hex.EncodeToString(c2s) != v.PairC2S {
		t.Fatalf("pair-c2s %x vs %s", c2s, v.PairC2S)
	}
	if hex.EncodeToString(s2c) != v.PairS2C {
		t.Fatalf("pair-s2c %x vs %s", s2c, v.PairS2C)
	}
}
