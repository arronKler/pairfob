package main

import (
	"errors"
	"fmt"
	"pairfob/internal/admin"
)

func stopLegacyProcess(sock string, peer *admin.Peer, _ serviceLayout) error {
	live, err := admin.OpenPeer(sock)
	if errors.Is(err, admin.ErrNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	defer live.Close()
	if live.PID != peer.PID {
		return errors.New("legacy socket owner changed; inspect again")
	}
	return fmt.Errorf("legacy Pairfob PID %d owns the local socket; its executable and state cannot be verified safely on macOS. Stop that instance explicitly, then run pairfob service restart", peer.PID)
}
