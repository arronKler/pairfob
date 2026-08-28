package state

import (
	"errors"
	"net/url"
	"os"
	"regexp"
	"strings"
)

const (
	pendingEnrollFile = "enroll-pending.json"
	pendingRekeyFile  = "rekey-pending.json"
)

var (
	pendingDaemonIDPattern = regexp.MustCompile(`^d_[0-9a-f]{20}$`)
	pendingTokenPattern    = regexp.MustCompile(`^rt_[0-9a-f]{32}$`)
	pendingGrantPattern    = regexp.MustCompile(`^jg_[0-9a-f]{32}$`)
)

// PendingEnroll keeps the client-minted credential durable until the hosted
// origin has acknowledged it and daemon.json plus relay.json are committed.
type PendingEnroll struct {
	Origin         string `json:"origin"`
	JoinGrant      string `json:"join_grant,omitempty"`
	DaemonID       string `json:"daemon_id"`
	ReconnectToken string `json:"reconnect_token"`
	CreatedAt      int64  `json:"created_at"`
}

// PendingRekey makes reconnect-token rotation retryable after an uncertain
// HTTP outcome. PreviousToken remains valid locally until NextToken commits.
type PendingRekey struct {
	Origin        string `json:"origin"`
	DaemonID      string `json:"daemon_id"`
	PreviousToken string `json:"previous_token"`
	NextToken     string `json:"next_token"`
	CreatedAt     int64  `json:"created_at"`
}

func (s *Store) LoadPendingEnroll() (PendingEnroll, bool, error) {
	var pending PendingEnroll
	ok, err := s.loadOptional(pendingEnrollFile, &pending)
	if err != nil || !ok {
		return pending, ok, err
	}
	if err := validatePendingOrigin(pending.Origin); err != nil ||
		!pendingGrantOK(pending.JoinGrant) ||
		!pendingDaemonIDPattern.MatchString(pending.DaemonID) ||
		!pendingTokenPattern.MatchString(pending.ReconnectToken) || pending.CreatedAt <= 0 {
		return PendingEnroll{}, false, errors.New("enroll-pending.json contains invalid credentials")
	}
	return pending, true, nil
}

func (s *Store) SavePendingEnroll(pending PendingEnroll) error {
	if err := validatePendingOrigin(pending.Origin); err != nil ||
		!pendingGrantOK(pending.JoinGrant) ||
		!pendingDaemonIDPattern.MatchString(pending.DaemonID) ||
		!pendingTokenPattern.MatchString(pending.ReconnectToken) || pending.CreatedAt <= 0 {
		return errors.New("invalid pending enroll credentials")
	}
	return atomicJSON(s.path(pendingEnrollFile), pending)
}

func (s *Store) ClearPendingEnroll() error { return s.clearOptional(pendingEnrollFile) }

func (s *Store) LoadPendingRekey() (PendingRekey, bool, error) {
	var pending PendingRekey
	ok, err := s.loadOptional(pendingRekeyFile, &pending)
	if err != nil || !ok {
		return pending, ok, err
	}
	if err := validatePendingOrigin(pending.Origin); err != nil ||
		!pendingDaemonIDPattern.MatchString(pending.DaemonID) ||
		!pendingTokenPattern.MatchString(pending.PreviousToken) ||
		!pendingTokenPattern.MatchString(pending.NextToken) ||
		pending.PreviousToken == pending.NextToken || pending.CreatedAt <= 0 {
		return PendingRekey{}, false, errors.New("rekey-pending.json contains invalid credentials")
	}
	return pending, true, nil
}

func (s *Store) SavePendingRekey(pending PendingRekey) error {
	if err := validatePendingOrigin(pending.Origin); err != nil ||
		!pendingDaemonIDPattern.MatchString(pending.DaemonID) ||
		!pendingTokenPattern.MatchString(pending.PreviousToken) ||
		!pendingTokenPattern.MatchString(pending.NextToken) ||
		pending.PreviousToken == pending.NextToken || pending.CreatedAt <= 0 {
		return errors.New("invalid pending rekey credentials")
	}
	return atomicJSON(s.path(pendingRekeyFile), pending)
}

func (s *Store) ClearPendingRekey() error { return s.clearOptional(pendingRekeyFile) }

func (s *Store) loadOptional(name string, dst any) (bool, error) {
	err := readJSON(s.path(name), dst)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) clearOptional(name string) error {
	err := os.Remove(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if dir, openErr := os.Open(s.Dir); openErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func pendingGrantOK(grant string) bool {
	return grant == "" || pendingGrantPattern.MatchString(grant)
}

func validatePendingOrigin(raw string) error {
	if raw == "" || len(raw) > 2048 || strings.HasSuffix(raw, "/") {
		return errors.New("invalid pending credential origin")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid pending credential origin")
	}
	return nil
}
