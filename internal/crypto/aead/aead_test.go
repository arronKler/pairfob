package aead

import (
	"bytes"
	"encoding/hex"
	"testing"

	"pairfob/internal/crypto/testvec"
)

func TestFrozenAEADPingAndCap(t *testing.T) {
	v := testvec.Load(t)
	if MaxPlaintext != v.MaxPlain {
		t.Fatalf("MaxPlaintext %d vs %d", MaxPlaintext, v.MaxPlain)
	}
	ref := testvec.Hex(t, v.PairRefHex)
	var rid [16]byte
	copy(rid[:], ref)
	c2s := testvec.Hex(t, v.PairC2S)
	d := &Direction{Key: c2s, Dir: DirClient}
	got, err := Seal(d, rid, []byte(v.PingPT))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(got) != v.AEADPing {
		t.Fatalf("aead_ping\n got %x\nwant %s", got, v.AEADPing)
	}
	open := &Direction{Key: c2s, Dir: DirClient}
	pt, err := Open(open, rid, got)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pt, []byte(v.PingPT)) {
		t.Fatalf("open %s", pt)
	}
	too := make([]byte, MaxPlaintext+1)
	if _, err := Seal(&Direction{Key: c2s, Dir: DirClient}, rid, too); err != ErrTooLarge {
		t.Fatalf("want ErrTooLarge got %v", err)
	}
}
