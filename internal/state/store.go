// Package state owns pairfob's durable identity, relay credential, devices, and
// Web Push subscription metadata. All files are written atomically with mode
// 0600 so a crash can leave either the old or the new complete JSON document.
package state

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"pairfob/internal/crypto/canon"
)

type Identity struct {
	DaemonID string `json:"daemon_id,omitempty"`
	SK       string `json:"ed25519_sk"`
	PK       string `json:"ed25519_pk"`
	Created  int64  `json:"created_at"`
	Hostname string `json:"hostname"`
}

type Relay struct {
	URL            string `json:"url,omitempty"`
	ReconnectToken string `json:"reconnect_token,omitempty"`
	Protocol       int    `json:"protocol,omitempty"`
}

type PushSubscription struct {
	Endpoint       string `json:"endpoint"`
	P256DH         string `json:"p256dh"`
	Auth           string `json:"auth"`
	ExpirationTime *int64 `json:"expirationTime,omitempty"`
	Created        int64  `json:"created_at"`
}

type Device struct {
	ID                string             `json:"device_id"`
	Label             string             `json:"label,omitempty"`
	PSK               string             `json:"device_psk"`
	UA                string             `json:"ua,omitempty"`
	Created           int64              `json:"created_at"`
	LastSeen          int64              `json:"last_seen,omitempty"`
	RevokedAt         *int64             `json:"revoked_at,omitempty"`
	PushSubscriptions []PushSubscription `json:"push_subscriptions,omitempty"`
}

type VAPID struct {
	Public  string `json:"public"`
	Private string `json:"private"`
	Subject string `json:"subject"`
}

type OperationError struct {
	Code      string `json:"code"`
	Operation string `json:"operation,omitempty"`
	Outcome   string `json:"outcome"`
	Retry     string `json:"retry"`
	Message   string `json:"message"`
}

type Operation struct {
	DeviceID    string          `json:"device_id"`
	OperationID string          `json:"operation_id"`
	Fingerprint string          `json:"fingerprint"`
	Status      string          `json:"status"`
	Receipt     json.RawMessage `json:"receipt,omitempty"`
	Error       *OperationError `json:"error,omitempty"`
	CreatedAt   int64           `json:"created_at"`
	CompletedAt int64           `json:"completed_at,omitempty"`
}

type Store struct{ Dir string }

func DefaultDir() (string, error) {
	if dir := os.Getenv("PAIRFOB_STATE_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "pairfob"), nil
}

func Open(dir string) (*Store, error) {
	if dir == "" {
		var err error
		dir, err = DefaultDir()
		if err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("state path must be a real directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	return &Store{Dir: dir}, nil
}

func (s *Store) path(name string) string { return filepath.Join(s.Dir, name) }

func readJSON(path string, dst any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a regular file", filepath.Base(path))
	}
	if err := os.Chmod(path, 0600); err != nil {
		return err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return fmt.Errorf("decode %s: %w", filepath.Base(path), err)
	}
	return nil
}

func atomicJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pairfob-state-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	ok = true
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return os.Chmod(path, 0600)
}

func (s *Store) LoadOrCreateIdentity() (Identity, ed25519.PublicKey, ed25519.PrivateKey, error) {
	var id Identity
	err := readJSON(s.path("daemon.json"), &id)
	if errors.Is(err, os.ErrNotExist) {
		pk, sk, genErr := ed25519.GenerateKey(rand.Reader)
		if genErr != nil {
			return id, nil, nil, genErr
		}
		host, _ := os.Hostname()
		id = Identity{SK: canon.B64URL(sk), PK: canon.B64URL(pk), Created: time.Now().Unix(), Hostname: host}
		if err := atomicJSON(s.path("daemon.json"), id); err != nil {
			return id, nil, nil, err
		}
		return id, pk, sk, nil
	}
	if err != nil {
		return id, nil, nil, err
	}
	pk, err := canon.DecodeB64URL(id.PK)
	if err != nil || len(pk) != ed25519.PublicKeySize {
		return id, nil, nil, errors.New("daemon.json contains invalid ed25519_pk")
	}
	sk, err := canon.DecodeB64URL(id.SK)
	if err != nil || len(sk) != ed25519.PrivateKeySize {
		return id, nil, nil, errors.New("daemon.json contains invalid ed25519_sk")
	}
	if !ed25519.PublicKey(pk).Equal(ed25519.PrivateKey(sk).Public()) {
		return id, nil, nil, errors.New("daemon.json keypair mismatch")
	}
	_ = os.Chmod(s.path("daemon.json"), 0600)
	return id, ed25519.PublicKey(pk), ed25519.PrivateKey(sk), nil
}

func (s *Store) SaveIdentity(id Identity) error { return atomicJSON(s.path("daemon.json"), id) }

func (s *Store) LoadRelay() (Relay, error) {
	var relay Relay
	err := readJSON(s.path("relay.json"), &relay)
	if errors.Is(err, os.ErrNotExist) {
		return relay, nil
	}
	if err != nil {
		return relay, err
	}
	if len(relay.URL) > 4096 || len(relay.ReconnectToken) > 256 {
		return relay, errors.New("relay.json contains oversized fields")
	}
	if relay.Protocol != 0 && relay.Protocol != 1 && relay.Protocol != 2 {
		return relay, errors.New("relay.json protocol must be 1 or 2")
	}
	return relay, nil
}

func (s *Store) SaveRelay(relay Relay) error { return atomicJSON(s.path("relay.json"), relay) }

func (s *Store) LoadDevices() ([]Device, error) {
	var devices []Device
	err := readJSON(s.path("devices.json"), &devices)
	if errors.Is(err, os.ErrNotExist) {
		return []Device{}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := validateDevices(devices); err != nil {
		return nil, err
	}
	return devices, nil
}

func (s *Store) SaveDevices(devices []Device) error {
	if err := validateDevices(devices); err != nil {
		return err
	}
	return atomicJSON(s.path("devices.json"), devices)
}

func (s *Store) LoadOperations() ([]Operation, error) {
	var operations []Operation
	err := readJSON(s.path("operations.json"), &operations)
	if errors.Is(err, os.ErrNotExist) {
		return []Operation{}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := validateOperations(operations); err != nil {
		return nil, err
	}
	return operations, nil
}

func (s *Store) SaveOperations(operations []Operation) error {
	if err := validateOperations(operations); err != nil {
		return err
	}
	return atomicJSON(s.path("operations.json"), operations)
}

var operationIDPattern = regexp.MustCompile(`^op_[A-Za-z0-9_-]{16,128}$`)
var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func validateOperations(operations []Operation) error {
	if len(operations) > 65536 {
		return errors.New("operations.json exceeds 65536 rows")
	}
	seen := make(map[string]struct{}, len(operations))
	for _, operation := range operations {
		if !deviceIDPattern.MatchString(operation.DeviceID) || !operationIDPattern.MatchString(operation.OperationID) || !fingerprintPattern.MatchString(operation.Fingerprint) {
			return errors.New("operations.json contains an invalid identity")
		}
		key := operation.DeviceID + "\x00" + operation.OperationID
		if _, exists := seen[key]; exists {
			return errors.New("operations.json contains duplicate operation ids")
		}
		seen[key] = struct{}{}
		if operation.CreatedAt <= 0 || (operation.Status != "pending" && operation.Status != "completed") {
			return errors.New("operations.json contains invalid operation state")
		}
		if operation.Status == "pending" {
			if len(operation.Receipt) != 0 || operation.Error != nil || operation.CompletedAt != 0 {
				return errors.New("pending operation contains a terminal result")
			}
		} else if operation.CompletedAt < operation.CreatedAt || len(operation.Receipt) == 0 || len(operation.Receipt) > 65536 {
			return errors.New("completed operation is missing a bounded result")
		}
	}
	return nil
}

var deviceIDPattern = regexp.MustCompile(`^dev_[A-Za-z0-9_-]{8,128}$`)

func validateDevices(devices []Device) error {
	if len(devices) > 1000 {
		return errors.New("devices.json exceeds 1000 rows")
	}
	seen := make(map[string]struct{}, len(devices))
	for _, device := range devices {
		if !deviceIDPattern.MatchString(device.ID) {
			return fmt.Errorf("devices.json contains invalid device_id %q", device.ID)
		}
		if _, exists := seen[device.ID]; exists {
			return fmt.Errorf("devices.json contains duplicate device_id %q", device.ID)
		}
		seen[device.ID] = struct{}{}
		psk, err := canon.DecodeB64URL(device.PSK)
		if err != nil || len(psk) != 32 {
			return fmt.Errorf("devices.json contains invalid PSK for %q", device.ID)
		}
		if len(device.PushSubscriptions) > 16 {
			return fmt.Errorf("devices.json contains too many subscriptions for %q", device.ID)
		}
		endpoints := map[string]struct{}{}
		for _, sub := range device.PushSubscriptions {
			u, err := url.Parse(sub.Endpoint)
			if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || len(sub.Endpoint) > 4096 {
				return fmt.Errorf("devices.json contains invalid push endpoint for %q", device.ID)
			}
			if _, exists := endpoints[sub.Endpoint]; exists {
				return fmt.Errorf("devices.json contains duplicate push endpoint for %q", device.ID)
			}
			endpoints[sub.Endpoint] = struct{}{}
			p256dh, keyErr := canon.DecodeB64URL(sub.P256DH)
			auth, authErr := canon.DecodeB64URL(sub.Auth)
			if keyErr != nil || len(p256dh) != 65 || p256dh[0] != 4 || authErr != nil || len(auth) != 16 {
				return fmt.Errorf("devices.json contains invalid push keys for %q", device.ID)
			}
			x, y := elliptic.Unmarshal(elliptic.P256(), p256dh)
			if x == nil || !elliptic.P256().IsOnCurve(x, y) {
				return fmt.Errorf("devices.json contains invalid push public key for %q", device.ID)
			}
		}
	}
	return nil
}

func (s *Store) LoadOrCreateVAPID(subject string) (VAPID, error) {
	var v VAPID
	err := readJSON(s.path("vapid.json"), &v)
	if err == nil {
		if err := validateVAPIDSubject(v.Subject); err != nil {
			return v, err
		}
		pub, pubErr := canon.DecodeB64URL(v.Public)
		priv, privErr := canon.DecodeB64URL(v.Private)
		if pubErr != nil || privErr != nil || len(pub) != 65 || len(priv) != 32 || pub[0] != 4 {
			return v, errors.New("vapid.json contains invalid P-256 key")
		}
		d := new(big.Int).SetBytes(priv)
		curve := elliptic.P256()
		if d.Sign() <= 0 || d.Cmp(curve.Params().N) >= 0 {
			return v, errors.New("vapid.json contains out-of-range P-256 private key")
		}
		x, y := curve.ScalarBaseMult(priv)
		if !bytes.Equal(pub, elliptic.Marshal(curve, x, y)) {
			return v, errors.New("vapid.json public/private key mismatch")
		}
		return v, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return v, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return v, err
	}
	priv := key.D.FillBytes(make([]byte, 32))
	pub := elliptic.Marshal(elliptic.P256(), key.X, key.Y)
	if subject == "" {
		subject = "mailto:operator@localhost"
	}
	if err := validateVAPIDSubject(subject); err != nil {
		return v, err
	}
	v = VAPID{Public: canon.B64URL(pub), Private: canon.B64URL(priv), Subject: subject}
	if err := atomicJSON(s.path("vapid.json"), v); err != nil {
		return v, err
	}
	return v, nil
}

func validateVAPIDSubject(subject string) error {
	if len(subject) == 0 || len(subject) > 512 {
		return errors.New("VAPID subject must be 1-512 bytes")
	}
	u, err := url.Parse(subject)
	if err != nil || u.Fragment != "" || u.User != nil {
		return errors.New("VAPID subject must be a mailto: or https: URL without userinfo or fragment")
	}
	switch u.Scheme {
	case "https":
		if u.Hostname() == "" {
			return errors.New("VAPID https subject requires a hostname")
		}
	case "mailto":
		address := strings.TrimPrefix(subject, "mailto:")
		if address == "" || strings.ContainsAny(address, "?#") {
			return errors.New("VAPID mailto subject requires an address")
		}
	default:
		return errors.New("VAPID subject scheme must be mailto or https")
	}
	return nil
}

func (s *Store) AuditPath() string { return s.path("audit.log") }
