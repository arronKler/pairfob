package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"

	"golang.org/x/crypto/curve25519"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/hkdfk"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/crypto/spake2plus"
)

func hx(b []byte) string { return hex.EncodeToString(b) }

func pad32(n interface{ FillBytes([]byte) []byte }) string {
	buf := make([]byte, 32)
	n.FillBytes(buf)
	return hx(buf)
}

func main() {
	root := "proto"
	if len(os.Args) > 1 {
		root = os.Args[1]
	}

	ref, err := hex.DecodeString("4f7a2c9e1b0d88aa55cc3311abde7001")
	if err != nil {
		panic(err)
	}
	pairRefHex := canon.PairRefHex(ref)
	normalizedS := "7K3M9H2P"
	daemonID := "d_test"
	deviceID := "dev_1"

	rec := spake2plus.DeriveRecord(normalizedS, daemonID, pairRefHex)
	idP := spake2plus.IdProver(pairRefHex)
	proverX := "d1232c8e8693d02368976c174e2088851b8365d0d79a9eee709c6a05a2fad539"
	verifierY := "717a72348a182085109c8d3917d6c43d59b224dc6a7fc4f0483232fa6516d8b3"
	p := spake2plus.NewProver(rec, idP, daemonID, "")
	shareP := p.StartWithX(spake2plus.ScalarFromHex(proverX))
	v := spake2plus.NewVerifier(rec, idP, daemonID, "")
	shareV, keysV, err := v.FinishWithY(shareP, spake2plus.ScalarFromHex(verifierY))
	if err != nil {
		panic(err)
	}
	keysP, err := p.Finish(shareV)
	if err != nil {
		panic(err)
	}
	if hx(keysP.KShared) != hx(keysV.KShared) {
		panic("k_shared mismatch")
	}
	sas := sessionkeys.SAS(keysP.KShared)
	c2s, s2c := sessionkeys.PairingKeys(keysP.KShared)

	ikm := []byte("yellow submarine yellow submarin") // 32
	hk := hkdfk.HKDF(ikm, hkdfk.Zeros32, []byte("pairfob-v1/sas"), 4)

	var rid [16]byte
	copy(rid[:], ref)
	dir := &aead.Direction{Key: c2s, Dir: aead.DirClient}
	pingPT := []byte(`{"v":1,"op":"Ping"}`)
	sealed, err := aead.Seal(dir, rid, pingPT)
	if err != nil {
		panic(err)
	}

	psk := make([]byte, 32)
	for i := range psk {
		psk[i] = byte(i)
	}
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 3)
	}
	sk := ed25519.NewKeyFromSeed(seed)
	pk := sk.Public().(ed25519.PublicKey)

	var ephPsk, ephDsk [32]byte
	ephPsk[0] = 9
	ephDsk[0] = 7
	var ephP, ephD, dh [32]byte
	curve25519.ScalarBaseMult(&ephP, &ephPsk)
	curve25519.ScalarBaseMult(&ephD, &ephDsk)
	curve25519.ScalarMult(&dh, &ephPsk, &ephD)

	nonce := make([]byte, 16)
	ts := int64(1787558400)
	td := sessionkeys.TranscriptD(daemonID, deviceID, ephP[:], ephD[:], nonce, ts, rid)
	tp := sessionkeys.TranscriptP(td)
	proofD := sessionkeys.Proof(psk, td)
	proofP := sessionkeys.Proof(psk, tp)
	sigD := sessionkeys.Sign(sk, td)
	sessC, sessS := sessionkeys.SessionKeys(dh[:], psk)

	out := map[string]any{
		"pair_ref_hex":  pairRefHex,
		"normalized_s":  normalizedS,
		"daemon_id":     daemonID,
		"device_id":     deviceID,
		"id_prover":     idP,
		"context":       spake2plus.Context,
		"prover_x":      proverX,
		"verifier_y":    verifierY,
		"w0":            pad32(rec.W0),
		"w1":            pad32(rec.W1),
		"L":             hx(rec.L),
		"shareP":        hx(shareP),
		"shareV":        hx(shareV),
		"k_shared":      hx(keysP.KShared),
		"k_shared_v":    hx(keysV.KShared),
		"confirm_p":     hx(keysP.ConfirmP),
		"confirm_v":     hx(keysV.ConfirmV),
		"sas":           sas,
		"pair_c2s":      hx(c2s),
		"pair_s2c":      hx(s2c),
		"hkdf_sas4":     hx(hk),
		"hkdf_sas4_ikm": hx(ikm),
		"aead_ping":     hx(sealed),
		"ping_pt":       string(pingPT),
		"max_plain":     aead.MaxPlaintext,
		"device_psk":    hx(psk),
		"ed25519_seed":  hx(seed),
		"ed25519_pk":    hx(pk),
		"fp":            canon.Fingerprint16(pk),
		"eph_p_sk":      hx(ephPsk[:]),
		"eph_d_sk":      hx(ephDsk[:]),
		"eph_p":         hx(ephP[:]),
		"eph_d":         hx(ephD[:]),
		"hello_nonce":   hx(nonce),
		"hello_ts":      ts,
		"hello_td":      hx(td),
		"hello_tp":      hx(tp),
		"proof_d":       hx(proofD),
		"proof_p":       hx(proofP),
		"sig_d":         hx(sigD),
		"sess_c2s":      hx(sessC),
		"sess_s2c":      hx(sessS),
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(root, "pairfob-vectors.json"), append(b, '\n'), 0644); err != nil {
		panic(err)
	}
}
