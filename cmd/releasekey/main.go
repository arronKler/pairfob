// Command releasekey manages the Ed25519 key pair that signs daemon release
// manifests. It is a build tool and is not shipped with pairfob.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	privateKeyFile = "release-signing.key"
	publicKeyFile  = "release-signing.pub"
	usage          = "usage: releasekey gen --out DIR | sign --key FILE --in FILE --out FILE | verify --pub HEX --in FILE --sig FILE"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "releasekey:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	switch args[0] {
	case "gen":
		return genCommand(args[1:])
	case "sign":
		return signCommand(args[1:])
	case "verify":
		return verifyCommand(args[1:])
	default:
		return fmt.Errorf("unknown command %q\n%s", args[0], usage)
	}
}

func genCommand(args []string) error {
	fs := newFlagSet("gen")
	out := fs.String("out", "", "directory for the generated key pair")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *out == "" || fs.NArg() != 0 {
		return errors.New("usage: releasekey gen --out DIR")
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*out, 0o700); err != nil {
		return err
	}
	keyPath := filepath.Join(*out, privateKeyFile)
	publicPath := filepath.Join(*out, publicKeyFile)
	key := []byte(base64.StdEncoding.EncodeToString(privateKey))
	if err := writeNewFile(keyPath, key, 0o600); err != nil {
		return err
	}
	if err := writeNewFile(publicPath, []byte(hex.EncodeToString(publicKey)), 0o644); err != nil {
		_ = os.Remove(keyPath)
		return err
	}
	fmt.Printf("wrote %s\nwrote %s\n", keyPath, publicPath)
	return nil
}

func signCommand(args []string) error {
	fs := newFlagSet("sign")
	keyPath := fs.String("key", "", "base64 private key file")
	inPath := fs.String("in", "", "file to sign")
	outPath := fs.String("out", "", "signature file")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *keyPath == "" || *inPath == "" || *outPath == "" || fs.NArg() != 0 {
		return errors.New("usage: releasekey sign --key FILE --in FILE --out FILE")
	}
	key, err := readPrivateKey(*keyPath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(*inPath)
	if err != nil {
		return err
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(key, data)) + "\n"
	return os.WriteFile(*outPath, []byte(signature), 0o644)
}

func verifyCommand(args []string) error {
	fs := newFlagSet("verify")
	publicKeyHex := fs.String("pub", "", "hex public key")
	inPath := fs.String("in", "", "signed file")
	sigPath := fs.String("sig", "", "base64 signature file")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if *publicKeyHex == "" || *inPath == "" || *sigPath == "" || fs.NArg() != 0 {
		return errors.New("usage: releasekey verify --pub HEX --in FILE --sig FILE")
	}
	publicKey, err := decodePublicKey(*publicKeyHex)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(*inPath)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(*sigPath)
	if err != nil {
		return err
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("signature file is not one base64 Ed25519 signature")
	}
	if !ed25519.Verify(publicKey, data, signature) {
		return errors.New("signature does not match")
	}
	return nil
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("%s\n%s", err, usage)
	}
	return nil
}

func readPrivateKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(decoded) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("%s is not a base64 %d-byte Ed25519 private key", path, ed25519.PrivateKeySize)
	}
	key := ed25519.PrivateKey(decoded)
	derived := ed25519.NewKeyFromSeed(key.Seed())
	if !bytes.Equal(derived.Public().(ed25519.PublicKey), key.Public().(ed25519.PublicKey)) {
		return nil, fmt.Errorf("%s has a mismatched Ed25519 public half", path)
	}
	return key, nil
}

func decodePublicKey(publicKeyHex string) (ed25519.PublicKey, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(publicKeyHex))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("public key must be 32 hex-encoded bytes")
	}
	return ed25519.PublicKey(raw), nil
}

func writeNewFile(path string, data []byte, perm os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if _, err = file.Write(data); err != nil {
		file.Close()
		_ = os.Remove(path)
		return err
	}
	if err = file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return os.Chmod(path, perm)
}
