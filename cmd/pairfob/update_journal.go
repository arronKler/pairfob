package main

import (
	"encoding/json"
	"fmt"
	"os"
	"pairfob/internal/daemon"
	"path/filepath"
)

// Persist the transition before replacing the executable. Unlike UI caches,
// recovery state must survive an abrupt process replacement.
func writeUpdateJournal(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".pairfob-update-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

type updateJournal struct {
	daemon.UpdateStatus
	CandidateHash string `json:"candidate_hash"`
	BackupHash    string `json:"backup_hash"`
}

func (u *remoteUpdater) load(data []byte) error {
	var j updateJournal
	if err := json.Unmarshal(data, &j); err != nil {
		return err
	}
	u.job = j.UpdateStatus
	u.candidateHash = j.CandidateHash
	u.backupHash = j.BackupHash
	return nil
}
func (u *remoteUpdater) restoreBackup() error {
	current, err := os.ReadFile(u.dest)
	if err != nil {
		return err
	}
	previous, err := os.ReadFile(u.backupPath())
	if err != nil {
		return err
	}
	if sha256Hex(current) != u.candidateHash && sha256Hex(current) != u.backupHash {
		return fmt.Errorf("binary changed outside update; refusing rollback")
	}
	if sha256Hex(previous) != u.backupHash {
		return fmt.Errorf("backup checksum mismatch")
	}
	if err = replaceExecutable(u.dest, previous); err != nil {
		return err
	}
	u.job.Phase = "rolled_back"
	if err = u.save(); err != nil {
		return err
	}
	return u.clearPending()
}

func (u *remoteUpdater) clearPending() error {
	path := u.dest + ".update-pending"
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if string(data) != u.jobPath() {
		return fmt.Errorf("pending update belongs to another state directory")
	}
	return os.Remove(path)
}
