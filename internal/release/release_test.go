package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func testKey(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(publicKey), privateKey
}

func testManifest(version string) Manifest {
	return Manifest{
		Schema:  Schema,
		Version: version,
		Commit:  strings.Repeat("a", 40),
		Files: map[string]File{
			"daemon/pairfob-linux-amd64": {SHA256: strings.Repeat("b", 64), Size: 1234},
			"install.sh":                 {SHA256: strings.Repeat("c", 64), Size: 99},
		},
	}
}

func encodeManifest(t *testing.T, manifest Manifest) []byte {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func sign(t *testing.T, key ed25519.PrivateKey, manifest []byte) []byte {
	t.Helper()
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest)) + "\n")
}

func usePublicKey(t *testing.T, publicKeyHex string) {
	t.Helper()
	previous := PublicKeyHex
	PublicKeyHex = publicKeyHex
	t.Cleanup(func() { PublicKeyHex = previous })
}

func TestVerifyAcceptsSignedManifest(t *testing.T) {
	publicKeyHex, privateKey := testKey(t)
	manifest := encodeManifest(t, testManifest("v1.2.3"))
	usePublicKey(t, publicKeyHex)
	if err := Verify(manifest, sign(t, privateKey, manifest)); err != nil {
		t.Fatal(err)
	}
	if err := VerifyWithKey(publicKeyHex, manifest, sign(t, privateKey, manifest)); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRequiresAnEmbeddedKey(t *testing.T) {
	_, privateKey := testKey(t)
	manifest := encodeManifest(t, testManifest("v1.2.3"))
	usePublicKey(t, "")
	err := Verify(manifest, sign(t, privateKey, manifest))
	if err == nil || !strings.Contains(err.Error(), "pairfob/internal/release.PublicKeyHex") || !strings.Contains(err.Error(), "ldflags") {
		t.Fatalf("got %v", err)
	}
}

func TestVerifyRejectsTampering(t *testing.T) {
	publicKeyHex, privateKey := testKey(t)
	manifest := encodeManifest(t, testManifest("v1.2.3"))
	signature := sign(t, privateKey, manifest)

	tamperedManifest := append([]byte(nil), manifest...)
	tamperedManifest[0] = '['
	if err := VerifyWithKey(publicKeyHex, tamperedManifest, signature); err == nil {
		t.Fatal("accepted tampered manifest")
	}
	if err := VerifyWithKey(publicKeyHex, manifest, []byte("not base64")); err == nil {
		t.Fatal("accepted malformed signature")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil {
		t.Fatal(err)
	}
	raw[0] ^= 0xff
	if err := VerifyWithKey(publicKeyHex, manifest, []byte(base64.StdEncoding.EncodeToString(raw))); err == nil {
		t.Fatal("accepted tampered signature")
	}
	otherPublic, _ := testKey(t)
	if err := VerifyWithKey(otherPublic, manifest, signature); err == nil {
		t.Fatal("accepted a signature from another key")
	}
}

func TestVerifyRejectsBadPublicKey(t *testing.T) {
	manifest := encodeManifest(t, testManifest("v1.2.3"))
	for _, key := range []string{"zz", strings.Repeat("a", 63), strings.Repeat("a", 65)} {
		if err := VerifyWithKey(key, manifest, []byte("sig")); err == nil || !strings.Contains(err.Error(), "public key") {
			t.Fatalf("%q: %v", key, err)
		}
	}
}

func TestParseManifestReadsVersionAndHashes(t *testing.T) {
	manifest, err := ParseManifest(encodeManifest(t, testManifest("v1.2.3")), "v1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Version != "v1.2.3" {
		t.Fatalf("version %q", manifest.Version)
	}
	hash, err := manifest.Hash("daemon/pairfob-linux-amd64")
	if err != nil || hash != strings.Repeat("b", 64) {
		t.Fatalf("hash=%q err=%v", hash, err)
	}
	if _, err := manifest.Hash("daemon/pairfob-darwin-arm64"); err == nil {
		t.Fatal("missing artifact was not rejected")
	}
}

func TestParseManifestNormalizesHashes(t *testing.T) {
	manifest := testManifest("1.0.0")
	manifest.Files["daemon/pairfob-linux-amd64"] = File{SHA256: strings.Repeat("B", 64), Size: 10}
	parsed, err := ParseManifest(encodeManifest(t, manifest), "")
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Files["daemon/pairfob-linux-amd64"].SHA256; got != strings.Repeat("b", 64) {
		t.Fatalf("got %q", got)
	}
}

func TestParseManifestFailsClosed(t *testing.T) {
	valid := encodeManifest(t, testManifest("v1.2.3"))
	unknownField := []byte(`{"schema":1,"version":"1.0.0","commit":"` + strings.Repeat("a", 40) + `","files":{"daemon/x":{"sha256":"` + strings.Repeat("b", 64) + `","size":1}},"extra":true}`)

	cases := []struct {
		name    string
		data    []byte
		version string
	}{
		{"malformed json", []byte("{"), ""},
		{"trailing data", append(append([]byte(nil), valid...), []byte(" {}")...), ""},
		{"unknown field", unknownField, ""},
		{"unknown schema", encodeManifest(t, Manifest{Schema: 2, Version: "1.0.0", Commit: strings.Repeat("a", 40), Files: testManifest("1.0.0").Files}), ""},
		{"missing version", encodeManifest(t, Manifest{Schema: 1, Commit: strings.Repeat("a", 40), Files: testManifest("1.0.0").Files}), ""},
		{"bad version", encodeManifest(t, testManifest("1.0")), ""},
		{"version mismatch", valid, "v1.2.4"},
		{"missing commit", encodeManifest(t, Manifest{Schema: 1, Version: "1.0.0", Files: testManifest("1.0.0").Files}), ""},
		{"missing files", encodeManifest(t, Manifest{Schema: 1, Version: "1.0.0", Commit: strings.Repeat("a", 40)}), ""},
		{"short hash", manifestWithFile(t, "daemon/x", File{SHA256: strings.Repeat("b", 63), Size: 1}), ""},
		{"non-hex hash", manifestWithFile(t, "daemon/x", File{SHA256: strings.Repeat("z", 64), Size: 1}), ""},
		{"missing size", manifestWithFile(t, "daemon/x", File{SHA256: strings.Repeat("b", 64)}), ""},
		{"oversized file", manifestWithFile(t, "daemon/x", File{SHA256: strings.Repeat("b", 64), Size: maxArtifactSize + 1}), ""},
		{"empty path", manifestWithFile(t, "", File{SHA256: strings.Repeat("b", 64), Size: 1}), ""},
		{"absolute path", manifestWithFile(t, "/daemon/x", File{SHA256: strings.Repeat("b", 64), Size: 1}), ""},
		{"traversal", manifestWithFile(t, "daemon/../x", File{SHA256: strings.Repeat("b", 64), Size: 1}), ""},
		{"backslash", manifestWithFile(t, `daemon\x`, File{SHA256: strings.Repeat("b", 64), Size: 1}), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseManifest(tc.data, tc.version); err == nil {
				t.Fatal("accepted invalid manifest")
			}
		})
	}
}

func manifestWithFile(t *testing.T, filePath string, file File) []byte {
	t.Helper()
	return encodeManifest(t, Manifest{
		Schema:  1,
		Version: "1.0.0",
		Commit:  strings.Repeat("a", 40),
		Files:   map[string]File{filePath: file},
	})
}
