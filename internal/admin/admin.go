// Package admin is the local operator seam for a running pairfob.
//
// The daemon is headless. Pairing Y/N, rotating a code, and device revoke
// happen over a 0600 Unix socket in the state directory — not a browser page.
package admin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"pairfob/internal/state"
)

const socketName = "pairfob.sock"

type Pairing struct {
	Ref       string    `json:"pair_ref,omitempty"`
	Code      string    `json:"code,omitempty"`
	URL       string    `json:"pair_url,omitempty"`
	Loc       string    `json:"pair_loc,omitempty"`
	Admitted  bool      `json:"admitted"`
	Ready     bool      `json:"ready"`
	Devices   int       `json:"devices"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
	Host      string    `json:"host,omitempty"`
	Runtime   string    `json:"runtime,omitempty"`
	P2P       *bool     `json:"p2p,omitempty"`
}

// Device is the operator-visible device row. It must never carry a PSK, UA,
// or push endpoint/key material.
type Device struct {
	ID                string `json:"device_id"`
	Label             string `json:"label,omitempty"`
	Created           int64  `json:"created_at"`
	LastSeen          int64  `json:"last_seen,omitempty"`
	RevokedAt         *int64 `json:"revoked_at,omitempty"`
	SubscriptionCount int    `json:"subscription_count"`
}

type Relay struct {
	URL      string `json:"url"`
	Protocol int    `json:"protocol"`
}

type Service interface {
	Status() Pairing
	NewPairing() (Pairing, error)
	WaitPairingReady(pairRef string) (Pairing, error)
	Admit(pairRef string) error
	Deny(pairRef string) error
	Devices() []Device
	Revoke(deviceID string) error
	Rekey() (Relay, error)
}

type Request struct {
	Op       string `json:"op"`
	PairRef  string `json:"pair_ref,omitempty"`
	DeviceID string `json:"device_id,omitempty"`
}

type Response struct {
	OK     bool            `json:"ok"`
	Error  string          `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

func SocketPath() (string, error) {
	if p := os.Getenv("PAIRFOB_ADMIN_SOCK"); p != "" {
		if !filepath.IsAbs(p) {
			return "", errors.New("PAIRFOB_ADMIN_SOCK must be an absolute path")
		}
		return filepath.Clean(p), nil
	}
	dir, err := state.DefaultDir()
	if err != nil {
		return "", err
	}
	return socketInDir(dir)
}

func SocketPathIn(dir string) (string, error) {
	if os.Getenv("PAIRFOB_ADMIN_SOCK") != "" || dir == "" {
		return SocketPath()
	}
	return socketInDir(dir)
}

func socketInDir(dir string) (string, error) {
	if dir == "" {
		return "", errors.New("admin socket path is empty")
	}
	if !filepath.IsAbs(dir) {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return "", err
		}
		dir = abs
	}
	return filepath.Join(filepath.Clean(dir), socketName), nil
}

func validatePath(path string) (string, error) {
	if path == "" {
		return "", errors.New("admin socket path must be absolute")
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("admin socket path must be absolute")
	}
	return filepath.Clean(path), nil
}
