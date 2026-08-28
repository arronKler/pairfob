package mux

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const registryVersion = 2

type reconnectRegistryFile struct {
	Version       int               `json:"version"`
	JoinTokenHash string            `json:"join_token_hash,omitempty"`
	Reconnect     map[string]string `json:"reconnect"`
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (h *Hub) loadReconnectRegistry() error {
	state, exists, err := readReconnectRegistry(h.statePath)
	if err != nil || !exists {
		return err
	}
	if state.JoinTokenHash != "" {
		// A persisted rotation takes precedence over an environment bootstrap
		// token. Maintenance commands explicitly take effect on next startup.
		h.joinHash = state.JoinTokenHash
	}
	h.diskReconnect = copyStringMap(state.Reconnect)
	for hash, daemonID := range state.Reconnect {
		h.reconnect[hash] = daemonID
	}
	return nil
}

// persistReconnectRegistryLocked requires h.mu held.
func (h *Hub) persistReconnectRegistryLocked() error {
	if h.statePath == "" {
		return nil
	}
	return withRegistryLock(h.statePath, func() error {
		return h.mergeAndWriteRegistry()
	})
}

func (h *Hub) mergeAndWriteRegistry() error {
	disk, exists, err := readReconnectRegistry(h.statePath)
	if err != nil {
		return err
	}
	joinHash := h.joinHash
	if exists && disk.JoinTokenHash != "" {
		joinHash = disk.JoinTokenHash
	}
	reconnect := map[string]string{}
	if exists {
		for hash, id := range disk.Reconnect {
			reconnect[hash] = id
		}
	}
	for hash, id := range h.reconnect {
		if _, onDisk := reconnect[hash]; onDisk {
			continue
		}
		if _, known := h.diskReconnect[hash]; known {
			continue
		}
		reconnect[hash] = id
	}
	if err := writeReconnectRegistry(h.statePath, reconnectRegistryFile{
		Version: registryVersion, JoinTokenHash: joinHash, Reconnect: reconnect,
	}); err != nil {
		return err
	}
	h.diskReconnect = copyStringMap(reconnect)
	return nil
}

func copyStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// RotateJoinToken replaces the persisted join credential and returns the new
// raw token exactly once. A running Hub is deliberately not mutated; the
// rotation becomes active when the relay next loads statePath.
func RotateJoinToken(statePath string) (string, error) {
	var token string
	err := withRegistryLock(statePath, func() error {
		state, _, err := readReconnectRegistry(statePath)
		if err != nil {
			return err
		}
		raw := make([]byte, 16)
		if _, err := rand.Read(raw); err != nil {
			return fmt.Errorf("generate join token: %w", err)
		}
		token = "pf_" + hex.EncodeToString(raw)
		state.Version = registryVersion
		state.JoinTokenHash = tokenHash(token)
		if state.Reconnect == nil {
			state.Reconnect = make(map[string]string)
		}
		return writeReconnectRegistry(statePath, state)
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// KickDaemon removes every persisted reconnect credential for daemonID. It
// does not claim to close a websocket in another already-running process.
func KickDaemon(statePath, daemonID string) (bool, error) {
	if !daemonIDPattern.MatchString(daemonID) {
		return false, errors.New("invalid daemon_id")
	}
	var removed bool
	err := withRegistryLock(statePath, func() error {
		state, exists, err := readReconnectRegistry(statePath)
		if err != nil {
			return err
		}
		if !exists {
			return errors.New("relay registry does not exist")
		}
		for hash, registeredID := range state.Reconnect {
			if registeredID == daemonID {
				delete(state.Reconnect, hash)
				removed = true
			}
		}
		if !removed {
			return nil
		}
		state.Version = registryVersion
		return writeReconnectRegistry(statePath, state)
	})
	if err != nil {
		return false, err
	}
	return removed, nil
}

func readReconnectRegistry(statePath string) (reconnectRegistryFile, bool, error) {
	state := reconnectRegistryFile{Version: registryVersion, Reconnect: make(map[string]string)}
	info, err := os.Stat(statePath)
	if errors.Is(err, os.ErrNotExist) {
		return state, false, nil
	}
	if err != nil {
		return state, false, fmt.Errorf("stat relay state: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return state, false, errors.New("relay state must be a regular owner-only file")
	}
	b, err := os.ReadFile(statePath)
	if err != nil {
		return state, false, fmt.Errorf("read relay state: %w", err)
	}
	if err := json.Unmarshal(b, &state); err != nil {
		return state, false, fmt.Errorf("decode relay state: %w", err)
	}
	if state.Version != 1 && state.Version != registryVersion {
		return state, false, fmt.Errorf("unsupported relay state version %d", state.Version)
	}
	if state.JoinTokenHash != "" && !isLowerHex(state.JoinTokenHash, sha256.Size) {
		return state, false, errors.New("invalid join token hash")
	}
	if state.Reconnect == nil {
		state.Reconnect = make(map[string]string)
	}
	for hash, daemonID := range state.Reconnect {
		if !isLowerHex(hash, sha256.Size) || !daemonIDPattern.MatchString(daemonID) {
			return state, false, errors.New("invalid reconnect registry entry")
		}
	}
	return state, true, nil
}

func writeReconnectRegistry(statePath string, state reconnectRegistryFile) error {
	if statePath == "" {
		return errors.New("empty relay state path")
	}
	parent := filepath.Dir(statePath)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return fmt.Errorf("secure relay state directory: %w", err)
	}
	b, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(parent, ".relay-state-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	removeTemp := true
	defer func() {
		if removeTemp {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, statePath); err != nil {
		return err
	}
	removeTemp = false
	if err := os.Chmod(statePath, 0o600); err != nil {
		return fmt.Errorf("secure relay state file: %w", err)
	}
	parentDir, err := os.Open(parent)
	if err != nil {
		return fmt.Errorf("open relay state directory: %w", err)
	}
	if err := parentDir.Sync(); err != nil {
		_ = parentDir.Close()
		return fmt.Errorf("sync relay state directory: %w", err)
	}
	if err := parentDir.Close(); err != nil {
		return fmt.Errorf("close relay state directory: %w", err)
	}
	return nil
}
