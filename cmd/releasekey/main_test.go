package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func generate(t *testing.T) (dir, publicKeyHex string) {
	t.Helper()
	dir = t.TempDir()
	if err := run([]string{"gen", "--out", dir}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, publicKeyFile))
	if err != nil {
		t.Fatal(err)
	}
	return dir, strings.TrimSpace(string(raw))
}

func TestGenWritesKeyPair(t *testing.T) {
	dir, publicKeyHex := generate(t)

	keyPath := filepath.Join(dir, privateKeyFile)
	publicPath := filepath.Join(dir, publicKeyFile)
	for path, want := range map[string]os.FileMode{keyPath: 0o600, publicPath: 0o644} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Fatalf("%s mode %o, want %o", path, got, want)
		}
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		t.Fatalf("private key=%d bytes err=%v", len(privateKey), err)
	}
	publicKey, err := hex.DecodeString(publicKeyHex)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		t.Fatalf("public key=%d bytes err=%v", len(publicKey), err)
	}
	derived := ed25519.NewKeyFromSeed(ed25519.PrivateKey(privateKey).Seed()).Public().(ed25519.PublicKey)
	if !strings.EqualFold(hex.EncodeToString(derived), publicKeyHex) {
		t.Fatal("public key does not match the private key")
	}
}

func TestGenDoesNotOverwriteAnExistingKey(t *testing.T) {
	dir, _ := generate(t)
	err := run([]string{"gen", "--out", dir})
	if err == nil || !strings.Contains(err.Error(), privateKeyFile) {
		t.Fatalf("got %v", err)
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	dir, publicKeyHex := generate(t)
	input := filepath.Join(dir, "release.json")
	output := filepath.Join(dir, "release.json.sig")
	if err := os.WriteFile(input, []byte(`{"schema":1}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"sign", "--key", filepath.Join(dir, privateKeyFile), "--in", input, "--out", output}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(raw), "\n") != 1 || !strings.HasSuffix(string(raw), "\n") {
		t.Fatalf("signature file must be one line: %q", raw)
	}
	if err := run([]string{"verify", "--pub", publicKeyHex, "--in", input, "--sig", output}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRejectsChangedInput(t *testing.T) {
	dir, publicKeyHex := generate(t)
	input := filepath.Join(dir, "release.json")
	output := filepath.Join(dir, "release.json.sig")
	if err := os.WriteFile(input, []byte("signed bytes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"sign", "--key", filepath.Join(dir, privateKeyFile), "--in", input, "--out", output}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(input, []byte("changed bytes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"verify", "--pub", publicKeyHex, "--in", input, "--sig", output}); err == nil {
		t.Fatal("accepted changed input")
	}
}

func TestVerifyRejectsAnotherKey(t *testing.T) {
	dir, _ := generate(t)
	_, otherPublicKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(dir, "release.json")
	output := filepath.Join(dir, "release.json.sig")
	if err := os.WriteFile(input, []byte("signed bytes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"sign", "--key", filepath.Join(dir, privateKeyFile), "--in", input, "--out", output}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"verify", "--pub", hex.EncodeToString(otherPublicKey), "--in", input, "--sig", output}); err == nil {
		t.Fatal("accepted a signature from another key")
	}
}

func TestCommandsRejectBadInput(t *testing.T) {
	dir, publicKeyHex := generate(t)
	badKey := filepath.Join(dir, "bad.key")
	if err := os.WriteFile(badKey, []byte("not base64"), 0o600); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(dir, "input")
	if err := os.WriteFile(input, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := [][]string{
		nil,
		{"unknown"},
		{"gen"},
		{"gen", "--out", dir},
		{"sign", "--key", badKey, "--in", input, "--out", filepath.Join(dir, "out")},
		{"sign", "--key", filepath.Join(dir, privateKeyFile), "--in", filepath.Join(dir, "missing"), "--out", filepath.Join(dir, "out")},
		{"verify", "--pub", "zz", "--in", input, "--sig", input},
		{"verify", "--pub", publicKeyHex, "--in", input, "--sig", badKey},
		{"verify", "--pub", publicKeyHex, "--in", input},
	}
	for _, args := range cases {
		if err := run(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}
