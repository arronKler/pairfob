package sessionkeys

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"testing"

	"golang.org/x/crypto/curve25519"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/hkdfk"
	"pairfob/internal/crypto/spake2plus"
	"pairfob/internal/crypto/testvec"
)

func TestFrozenDeviceHelloAndSessionKeys(t *testing.T) {
	v := testvec.Load(t)
	kShared := testvec.Hex(t, v.KShared)
	if SAS(kShared) != v.SAS {
		t.Fatalf("sas %s vs %s", SAS(kShared), v.SAS)
	}
	c2s, s2c := PairingKeys(kShared)
	if hex.EncodeToString(c2s) != v.PairC2S || hex.EncodeToString(s2c) != v.PairS2C {
		t.Fatalf("pairing keys %x %x", c2s, s2c)
	}

	ref := testvec.Hex(t, v.PairRefHex)
	var rid [16]byte
	copy(rid[:], ref)
	ephP := testvec.Hex(t, v.EphP)
	ephD := testvec.Hex(t, v.EphD)
	nonce := testvec.Hex(t, v.HelloNonce)
	td := TranscriptD(v.DaemonID, v.DeviceID, ephP, ephD, nonce, v.HelloTS, rid)
	if hex.EncodeToString(td) != v.HelloTD {
		t.Fatalf("hello_td\n got %x\nwant %s", td, v.HelloTD)
	}
	tp := TranscriptP(td)
	if hex.EncodeToString(tp) != v.HelloTP {
		t.Fatalf("hello_tp %x", tp)
	}
	psk := testvec.Hex(t, v.DevicePSK)
	if hex.EncodeToString(Proof(psk, td)) != v.ProofD {
		t.Fatalf("proof_d")
	}
	if hex.EncodeToString(Proof(psk, tp)) != v.ProofP {
		t.Fatalf("proof_p")
	}
	seed := testvec.Hex(t, v.Ed25519Seed)
	sk := ed25519.NewKeyFromSeed(seed)
	pk := sk.Public().(ed25519.PublicKey)
	if hex.EncodeToString(pk) != v.Ed25519PK {
		t.Fatalf("ed25519 pk %x vs %s", pk, v.Ed25519PK)
	}
	if canon.Fingerprint16(pk) != v.FP {
		t.Fatalf("fp %s vs %s", canon.Fingerprint16(pk), v.FP)
	}
	sig := Sign(sk, td)
	if hex.EncodeToString(sig) != v.SigD {
		t.Fatalf("sig_d %x vs %s", sig, v.SigD)
	}
	if !VerifySig(pk, td, sig) {
		t.Fatal("sig verify")
	}

	var ephPsk, ephDsk, ephPpub, ephDpub, dh [32]byte
	copy(ephPsk[:], testvec.Hex(t, v.EphPSK))
	copy(ephDsk[:], testvec.Hex(t, v.EphDSK))
	curve25519.ScalarBaseMult(&ephPpub, &ephPsk)
	curve25519.ScalarBaseMult(&ephDpub, &ephDsk)
	if hex.EncodeToString(ephPpub[:]) != v.EphP || hex.EncodeToString(ephDpub[:]) != v.EphD {
		t.Fatalf("eph pubs")
	}
	curve25519.ScalarMult(&dh, &ephPsk, &ephDpub)
	sc, ss := SessionKeys(dh[:], psk)
	if hex.EncodeToString(sc) != v.SessC2S || hex.EncodeToString(ss) != v.SessS2C {
		t.Fatalf("sess keys %x %x", sc, ss)
	}
}

func TestAEADRoundTripAndCap(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	var rid [16]byte
	rand.Read(rid[:])
	c := &aead.Direction{Key: key, Dir: aead.DirClient}
	s := &aead.Direction{Key: key, Dir: aead.DirClient}
	pt := []byte(`{"v":1,"op":"Ping"}`)
	payload, err := aead.Seal(c, rid, pt)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) != 12+len(pt)+16 {
		t.Fatalf("len %d", len(payload))
	}
	got, err := aead.Open(s, rid, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, pt) {
		t.Fatal(string(got))
	}
	too := make([]byte, aead.MaxPlaintext+1)
	if _, err := aead.Seal(c, rid, too); err != aead.ErrTooLarge {
		t.Fatalf("want ErrTooLarge got %v", err)
	}
}

func TestDeviceHelloTranscript(t *testing.T) {
	psk := make([]byte, 32)
	rand.Read(psk)
	pk, sk, _ := ed25519.GenerateKey(rand.Reader)
	var ephP, ephD [32]byte
	rand.Read(ephP[:])
	rand.Read(ephD[:])
	var n16 [16]byte
	rand.Read(n16[:])
	var rid [16]byte
	rand.Read(rid[:])
	td := TranscriptD("d_01", "dev_01", ephP[:], ephD[:], n16[:], 1787558400, rid)
	if !hmacEqual(Proof(psk, td), hkdfk.HMACSHA256(psk, td)) {
		t.Fatal("proof")
	}
	sig := Sign(sk, td)
	if !VerifySig(pk, td, sig) {
		t.Fatal("sig")
	}
	tp := TranscriptP(td)
	if !bytes.HasPrefix(tp, canon.EncStr("pairfob-v1/hello-p")) {
		t.Fatal("prefix")
	}
	_, _ = SessionKeys(bytes.Repeat([]byte{1}, 32), psk)
}

func hmacEqual(a, b []byte) bool { return bytes.Equal(a, b) }

func TestX25519SessionKeysDeterministic(t *testing.T) {
	var a, b [32]byte
	a[0] = 9
	b[0] = 7
	var pubA, pubB [32]byte
	curve25519.ScalarBaseMult(&pubA, &a)
	curve25519.ScalarBaseMult(&pubB, &b)
	var dhA, dhB [32]byte
	curve25519.ScalarMult(&dhA, &a, &pubB)
	curve25519.ScalarMult(&dhB, &b, &pubA)
	if dhA != dhB {
		t.Fatal("dh")
	}
	psk := bytes.Repeat([]byte{2}, 32)
	c1, s1 := SessionKeys(dhA[:], psk)
	c2, s2 := SessionKeys(dhB[:], psk)
	if !bytes.Equal(c1, c2) || !bytes.Equal(s1, s2) {
		t.Fatal("session keys")
	}
}

func TestSASUsesPGPLists(t *testing.T) {
	rec := spake2plus.DeriveRecord("7K3M9H2P", "d_test", "4f7a2c9e1b0d88aa55cc3311abde7001")
	p := spake2plus.NewProver(rec, spake2plus.IdProver("4f7a2c9e1b0d88aa55cc3311abde7001"), "d_test", "")
	shareP := p.Start()
	v := spake2plus.NewVerifier(rec, spake2plus.IdProver("4f7a2c9e1b0d88aa55cc3311abde7001"), "d_test", "")
	shareV, keysV, err := v.Finish(shareP)
	if err != nil {
		t.Fatal(err)
	}
	keysP, err := p.Finish(shareV)
	if err != nil {
		t.Fatal(err)
	}
	sas := SAS(keysP.KShared)
	if sas != SAS(keysV.KShared) {
		t.Fatal(sas)
	}
	if sas == "" || sas[0] == '-' {
		t.Fatal(sas)
	}
}
