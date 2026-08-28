package spake2plus

import (
	"encoding/hex"
	"testing"

	"pairfob/internal/crypto/testvec"
)

func TestFrozenPairfobVectors(t *testing.T) {
	v := testvec.Load(t)
	if IdProver(v.PairRefHex) != v.IDProver || v.IDProver != "phone"+v.PairRefHex {
		t.Fatalf("idProver %s", IdProver(v.PairRefHex))
	}

	rec := DeriveRecord(v.NormalizedS, v.DaemonID, v.PairRefHex)
	if hex.EncodeToString(rec.W0.FillBytes(make([]byte, 32))) != v.W0 {
		t.Fatalf("w0 %s vs %s", rec.W0.Text(16), v.W0)
	}
	if hex.EncodeToString(rec.W1.FillBytes(make([]byte, 32))) != v.W1 {
		t.Fatalf("w1 %s vs %s", rec.W1.Text(16), v.W1)
	}
	if hex.EncodeToString(rec.L) != v.L {
		t.Fatalf("L %x vs %s", rec.L, v.L)
	}

	pr := NewProver(rec, IdProver(v.PairRefHex), v.DaemonID, v.Context)
	shareP := pr.StartWithX(ScalarFromHex(v.ProverX))
	if hex.EncodeToString(shareP) != v.ShareP {
		t.Fatalf("shareP\n got %x\nwant %s", shareP, v.ShareP)
	}
	ver := NewVerifier(rec, IdProver(v.PairRefHex), v.DaemonID, v.Context)
	shareV, keysV, err := ver.FinishWithY(shareP, ScalarFromHex(v.VerifierY))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(shareV) != v.ShareV {
		t.Fatalf("shareV %x vs %s", shareV, v.ShareV)
	}
	keysP, err := pr.Finish(shareV)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(keysP.KShared) != v.KShared {
		t.Fatalf("prover k_shared %x vs %s", keysP.KShared, v.KShared)
	}
	if hex.EncodeToString(keysV.KShared) != v.KSharedV || v.KShared != v.KSharedV {
		t.Fatalf("verifier k_shared %x vs %s", keysV.KShared, v.KSharedV)
	}
	if hex.EncodeToString(keysP.ConfirmP) != v.ConfirmP {
		t.Fatalf("confirmP %x", keysP.ConfirmP)
	}
	if hex.EncodeToString(keysV.ConfirmV) != v.ConfirmV {
		t.Fatalf("confirmV %x", keysV.ConfirmV)
	}
	if !ConfirmEqual(keysP.ConfirmP, keysV.ConfirmP) || !ConfirmEqual(keysP.ConfirmV, keysV.ConfirmV) {
		t.Fatal("confirm tags not equal across sides")
	}
}
