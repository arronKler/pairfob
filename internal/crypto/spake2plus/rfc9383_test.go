package spake2plus

import (
	"encoding/hex"
	"testing"
)

func TestRFC9383P256SHA256(t *testing.T) {
	// Appendix C first vector (PBKDF omitted; w0/w1 given).
	rec := RecordFromHex(
		"bb8e1bbcf3c48f62c08db243652ae55d3e5586053fca77102994f23ad95491b3",
		"7e945f34d78785b8a3ef44d0df5a1a97d6b3b460409a345ca7830387a74b1dba",
		"04eb7c9db3d9a9eb1f8adab81b5794c1f13ae3e225efbe91ea487425854c7fc00f00bfedcbd09b2400142d40a14f2064ef31dfaa903b91d1faea7093d835966efd",
	)
	ctx := "SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors"
	p := NewProver(rec, "client", "server", ctx)
	shareP := p.StartWithX(ScalarFromHex("d1232c8e8693d02368976c174e2088851b8365d0d79a9eee709c6a05a2fad539"))
	wantP := "04ef3bd051bf78a2234ec0df197f7828060fe9856503579bb1733009042c15c0c1de127727f418b5966afadfdd95a6e4591d171056b333dab97a79c7193e341727"
	if hex.EncodeToString(shareP) != wantP {
		t.Fatalf("shareP\n got %x\nwant %s", shareP, wantP)
	}
	v := NewVerifier(rec, "client", "server", ctx)
	shareV, keysV, err := v.FinishWithY(shareP, ScalarFromHex("717a72348a182085109c8d3917d6c43d59b224dc6a7fc4f0483232fa6516d8b3"))
	if err != nil {
		t.Fatal(err)
	}
	wantV := "04c0f65da0d11927bdf5d560c69e1d7d939a05b0e88291887d679fcadea75810fb5cc1ca7494db39e82ff2f50665255d76173e09986ab46742c798a9a68437b048"
	if hex.EncodeToString(shareV) != wantV {
		t.Fatalf("shareV\n got %x\nwant %s", shareV, wantV)
	}
	keysP, err := p.Finish(shareV)
	if err != nil {
		t.Fatal(err)
	}
	wantShared := "0c5f8ccd1413423a54f6c1fb26ff01534a87f893779c6e68666d772bfd91f3e7"
	if hex.EncodeToString(keysP.KShared) != wantShared {
		t.Fatalf("prover K_shared %x want %s", keysP.KShared, wantShared)
	}
	if hex.EncodeToString(keysV.KShared) != wantShared {
		t.Fatalf("verifier K_shared %x want %s", keysV.KShared, wantShared)
	}
	wantCP := "926cc713504b9b4d76c9162ded04b5493e89109f6d89462cd33adc46fda27527"
	wantCV := "9747bcc4f8fe9f63defee53ac9b07876d907d55047e6ff2def2e7529089d3e68"
	if hex.EncodeToString(keysP.ConfirmP) != wantCP {
		t.Fatalf("confirmP %x want %s", keysP.ConfirmP, wantCP)
	}
	if hex.EncodeToString(keysV.ConfirmV) != wantCV {
		t.Fatalf("confirmV %x want %s", keysV.ConfirmV, wantCV)
	}
}

func TestPairfobRoundTrip(t *testing.T) {
	pairRef, _ := hex.DecodeString("4f7a2c9e1b0d88aa55cc3311abde7001")
	_ = pairRef
	rec := DeriveRecord("7K3M9H2P", "d_test", "4f7a2c9e1b0d88aa55cc3311abde7001")
	idP := IdProver("4f7a2c9e1b0d88aa55cc3311abde7001")
	p := NewProver(rec, idP, "d_test", Context)
	shareP := p.Start()
	v := NewVerifier(rec, idP, "d_test", Context)
	shareV, keysV, err := v.Finish(shareP)
	if err != nil {
		t.Fatal(err)
	}
	keysP, err := p.Finish(shareV)
	if err != nil {
		t.Fatal(err)
	}
	if !ConfirmEqual(keysP.KShared, keysV.KShared) {
		t.Fatal("K_shared mismatch")
	}
	if !ConfirmEqual(keysP.ConfirmV, keysV.ConfirmV) || !ConfirmEqual(keysP.ConfirmP, keysV.ConfirmP) {
		t.Fatal("confirm tags mismatch")
	}
}
