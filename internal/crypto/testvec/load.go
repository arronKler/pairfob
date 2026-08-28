// Package testvec loads proto/pairfob-vectors.json for tests of shipped crypto.
package testvec

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type Vec struct {
	PairRefHex  string `json:"pair_ref_hex"`
	NormalizedS string `json:"normalized_s"`
	DaemonID    string `json:"daemon_id"`
	DeviceID    string `json:"device_id"`
	IDProver    string `json:"id_prover"`
	Context     string `json:"context"`
	ProverX     string `json:"prover_x"`
	VerifierY   string `json:"verifier_y"`
	W0          string `json:"w0"`
	W1          string `json:"w1"`
	L           string `json:"L"`
	ShareP      string `json:"shareP"`
	ShareV      string `json:"shareV"`
	KShared     string `json:"k_shared"`
	KSharedV    string `json:"k_shared_v"`
	ConfirmP    string `json:"confirm_p"`
	ConfirmV    string `json:"confirm_v"`
	SAS         string `json:"sas"`
	PairC2S     string `json:"pair_c2s"`
	PairS2C     string `json:"pair_s2c"`
	HKDFSAS4    string `json:"hkdf_sas4"`
	HKDFSAS4IKM string `json:"hkdf_sas4_ikm"`
	AEADPing    string `json:"aead_ping"`
	PingPT      string `json:"ping_pt"`
	MaxPlain    int    `json:"max_plain"`
	DevicePSK   string `json:"device_psk"`
	Ed25519Seed string `json:"ed25519_seed"`
	Ed25519PK   string `json:"ed25519_pk"`
	FP          string `json:"fp"`
	EphPSK      string `json:"eph_p_sk"`
	EphDSK      string `json:"eph_d_sk"`
	EphP        string `json:"eph_p"`
	EphD        string `json:"eph_d"`
	HelloNonce  string `json:"hello_nonce"`
	HelloTS     int64  `json:"hello_ts"`
	HelloTD     string `json:"hello_td"`
	HelloTP     string `json:"hello_tp"`
	ProofD      string `json:"proof_d"`
	ProofP      string `json:"proof_p"`
	SigD        string `json:"sig_d"`
	SessC2S     string `json:"sess_c2s"`
	SessS2C     string `json:"sess_s2c"`
}

func Load(t testing.TB) Vec {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	p := filepath.Join(filepath.Dir(file), "..", "..", "..", "proto", "pairfob-vectors.json")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var v Vec
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if v.NormalizedS != "7K3M9H2P" {
		t.Fatalf("pairing code %s", v.NormalizedS)
	}
	if v.MaxPlain != 262116 {
		t.Fatalf("max_plain %d", v.MaxPlain)
	}
	return v
}

func Hex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
