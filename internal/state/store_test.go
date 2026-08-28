package state

import (
	"crypto/elliptic"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pairfob/internal/crypto/canon"
)

func TestStoreIdentityVAPIDAndModes(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	id1, pk1, sk1, err := store.LoadOrCreateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	id2, pk2, sk2, err := store.LoadOrCreateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if id1.Created != id2.Created || !pk1.Equal(pk2) || !sk1.Equal(sk2) {
		t.Fatal("daemon identity was not stable across reload")
	}
	vapid, err := store.LoadOrCreateVAPID("https://operator.example/contact")
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := canon.DecodeB64URL(vapid.Public)
	priv, _ := canon.DecodeB64URL(vapid.Private)
	x, y := elliptic.P256().ScalarBaseMult(priv)
	if got := elliptic.Marshal(elliptic.P256(), x, y); string(got) != string(pub) {
		t.Fatal("VAPID keypair mismatch")
	}
	for _, name := range []string{"daemon.json", "vapid.json"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("%s mode=%o want 600", name, info.Mode().Perm())
		}
	}
}

func TestVAPIDRejectsBadSubjectAndMismatchedKey(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.LoadOrCreateVAPID("http://insecure.example"); err == nil {
		t.Fatal("insecure VAPID subject accepted")
	}
	valid, err := store.LoadOrCreateVAPID("mailto:operator@example.com")
	if err != nil {
		t.Fatal(err)
	}
	other, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	otherVAPID, err := other.LoadOrCreateVAPID("mailto:operator@example.com")
	if err != nil {
		t.Fatal(err)
	}
	valid.Public = otherVAPID.Public
	b, _ := json.Marshal(valid)
	if err := os.WriteFile(store.path("vapid.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LoadOrCreateVAPID(""); err == nil {
		t.Fatal("mismatched VAPID keypair accepted")
	}
}

func TestDevicesRejectDuplicatesInvalidIDsAndMalformedSubscriptions(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	psk := canon.B64URL(make([]byte, 32))
	duplicate := []Device{{ID: "dev_12345678", PSK: psk}, {ID: "dev_12345678", PSK: psk}}
	if err := store.SaveDevices(duplicate); err == nil {
		t.Fatal("duplicate device rows accepted")
	}
	if err := store.SaveDevices([]Device{{ID: "bad", PSK: psk}}); err == nil {
		t.Fatal("invalid device id accepted")
	}
	badSub := Device{ID: "dev_12345678", PSK: psk, PushSubscriptions: []PushSubscription{{
		Endpoint: "https://push.example/send", P256DH: canon.B64URL(make([]byte, 65)), Auth: canon.B64URL(make([]byte, 16)),
	}}}
	if err := store.SaveDevices([]Device{badSub}); err == nil {
		t.Fatal("off-curve subscription key accepted")
	}
}

func TestRelayProtocolRoundTrip(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	want := Relay{
		URL:            "wss://pairfob.com/v2/ws?role=daemon&daemon_id=d_0123456789abcdef0123",
		ReconnectToken: "rt_" + strings.Repeat("ab", 16),
		Protocol:       2,
	}
	if err := store.SaveRelay(want); err != nil {
		t.Fatal(err)
	}
	got, err := store.LoadRelay()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("relay=%+v want %+v", got, want)
	}
	if err := os.WriteFile(store.path("relay.json"), []byte(`{"protocol":9}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LoadRelay(); err == nil {
		t.Fatal("invalid protocol accepted")
	}
}

func TestOperationLedgerRoundTripAndValidation(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rows := []Operation{{
		DeviceID: "dev_12345678", OperationID: "op_AAECAwQFBgcICQoL",
		Fingerprint: strings.Repeat("a", 64), Status: "pending", CreatedAt: 1,
	}}
	if err := store.SaveOperations(rows); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.LoadOperations()
	if err != nil || len(loaded) != 1 || loaded[0].OperationID != rows[0].OperationID {
		t.Fatalf("loaded=%+v err=%v", loaded, err)
	}
	if info, err := os.Stat(filepath.Join(store.Dir, "operations.json")); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("operations mode info=%v err=%v", info, err)
	}
	invalid := rows[0]
	invalid.Status = "completed"
	if err := store.SaveOperations([]Operation{invalid}); err == nil {
		t.Fatal("completed operation without receipt was accepted")
	}
}
