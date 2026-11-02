// Package release verifies the signed daemon release manifest published at
// dl.pairfob.com/daemon/release.json.
package release

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
)

// Schema is the only daemon release manifest schema this package accepts.
const Schema = 1

// PublicKeyHex is the hex-encoded Ed25519 public key trusted for daemon
// release manifests. Release builds set it with
// -ldflags "-X pairfob/internal/release.PublicKeyHex=<hex>".
var PublicKeyHex string

var (
	semver    = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
	commitHex = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

const maxArtifactSize = 64 << 20

// File is one published artifact in a release manifest.
type File struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Manifest is the daemon release inventory. Files are keyed by their path
// relative to the download origin, for example "daemon/pairfob-linux-amd64".
type Manifest struct {
	Schema  int             `json:"schema"`
	Version string          `json:"version"`
	Commit  string          `json:"commit"`
	Files   map[string]File `json:"files"`
}

// Hash returns the SHA-256 for a path in the manifest.
func (m Manifest) Hash(filePath string) (string, error) {
	info, ok := m.Files[filePath]
	if !ok {
		return "", fmt.Errorf("release manifest has no entry for %s", filePath)
	}
	return info.SHA256, nil
}

// Verify checks signature over the exact manifest bytes with the embedded
// public key.
func Verify(manifest, signature []byte) error {
	return VerifyWithKey(PublicKeyHex, manifest, signature)
}

// VerifyWithKey checks a base64 Ed25519 signature over manifest with an
// explicit hex public key.
func VerifyWithKey(publicKeyHex string, manifest, signature []byte) error {
	key, err := decodePublicKey(publicKeyHex)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return errors.New("release signature is not a base64 Ed25519 signature")
	}
	if !ed25519.Verify(key, manifest, sig) {
		return errors.New("release manifest signature does not match")
	}
	return nil
}

func decodePublicKey(publicKeyHex string) (ed25519.PublicKey, error) {
	value := strings.TrimSpace(publicKeyHex)
	if value == "" {
		return nil, errors.New(`release public key is not embedded in this build; rebuild with -ldflags "-X pairfob/internal/release.PublicKeyHex=<hex>"`)
	}
	raw, err := hex.DecodeString(value)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("release public key must be 32 hex-encoded bytes")
	}
	return ed25519.PublicKey(raw), nil
}

// ParseManifest decodes a release manifest strictly. When expectedVersion is
// not empty the manifest version must match it exactly.
func ParseManifest(data []byte, expectedVersion string) (Manifest, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("release manifest: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Manifest{}, errors.New("release manifest has trailing data")
	}
	if manifest.Schema != Schema {
		return Manifest{}, fmt.Errorf("release manifest schema %d is not supported", manifest.Schema)
	}
	if !semver.MatchString(manifest.Version) {
		return Manifest{}, fmt.Errorf("release manifest version %q is not three-part SemVer", manifest.Version)
	}
	if expectedVersion != "" && manifest.Version != expectedVersion {
		return Manifest{}, fmt.Errorf("release manifest version %s does not match VERSION %s", manifest.Version, expectedVersion)
	}
	if !commitHex.MatchString(manifest.Commit) {
		return Manifest{}, errors.New("release manifest commit is not a 40-character hex revision")
	}
	if len(manifest.Files) == 0 {
		return Manifest{}, errors.New("release manifest lists no files")
	}
	for filePath, info := range manifest.Files {
		if !validFilePath(filePath) {
			return Manifest{}, fmt.Errorf("release manifest has an invalid file path %q", filePath)
		}
		sum := strings.ToLower(info.SHA256)
		if !sha256Hex.MatchString(sum) {
			return Manifest{}, fmt.Errorf("release manifest has an invalid SHA-256 for %s", filePath)
		}
		if info.Size <= 0 || info.Size > maxArtifactSize {
			return Manifest{}, fmt.Errorf("release manifest has an invalid size for %s", filePath)
		}
		manifest.Files[filePath] = File{SHA256: sum, Size: info.Size}
	}
	return manifest, nil
}

func validFilePath(filePath string) bool {
	if filePath == "" || strings.HasPrefix(filePath, "/") || strings.Contains(filePath, `\`) || path.Clean(filePath) != filePath {
		return false
	}
	for _, segment := range strings.Split(filePath, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}
