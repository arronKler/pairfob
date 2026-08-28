package canon

import (
	"encoding/hex"
	"testing"

	"pairfob/internal/crypto/testvec"
)

func TestPairRefHexWorkExample(t *testing.T) {
	v := testvec.Load(t)
	ref := testvec.Hex(t, v.PairRefHex)
	if PairRefHex(ref) != v.PairRefHex {
		t.Fatalf("hex %s", PairRefHex(ref))
	}
	wantRef, _ := hex.DecodeString("4f7a2c9e1b0d88aa55cc3311abde7001")
	if PairRefHex(wantRef) != "4f7a2c9e1b0d88aa55cc3311abde7001" {
		t.Fatalf("pair_ref %q", PairRefHex(wantRef))
	}
}

func TestEncStr(t *testing.T) {
	b := EncStr("ab")
	if len(b) != 10 || b[0] != 2 || string(b[8:]) != "ab" {
		t.Fatalf("%x", b)
	}
}

func TestNormalizeCrockford(t *testing.T) {
	if NormalizeCrockford("7k3m-h2p") != "7K3MH2P" {
		t.Fatal(NormalizeCrockford("7k3m-h2p"))
	}
	if NormalizeCrockford("ilo") != "110" {
		t.Fatal(NormalizeCrockford("ilo"))
	}
}

func TestDecodeB64URLStrictCanonical(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
	}{
		{"", ""},
		{"AA", "00"},
		{"AAA", "0000"},
		{"_-4", "ffee"},
	} {
		got, err := DecodeB64URL(tc.in)
		if err != nil || hex.EncodeToString(got) != tc.want {
			t.Fatalf("DecodeB64URL(%q)=%x,%v want %s", tc.in, got, err, tc.want)
		}
	}
	for _, invalid := range []string{"A", "AB", "AAB", "AA=", "+/8", "\u00e9"} {
		if got, err := DecodeB64URL(invalid); err == nil {
			t.Fatalf("DecodeB64URL(%q)=%x accepted non-canonical input", invalid, got)
		}
	}
}
