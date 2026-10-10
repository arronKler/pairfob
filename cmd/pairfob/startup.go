package main

import (
	"fmt"
	"io"
	"strings"

	"pairfob/internal/admin"
	"pairfob/internal/state"
)

func runBareCommand(w io.Writer, sock string, tty bool) error {
	if !tty {
		return runForeground()
	}
	if daemonIsLive(sock) {
		return writeLiveSnapshot(w, sock)
	}
	hint := localServiceHint()
	fmt.Fprintf(w, "Pairfob isn't running — %s.\n%s\n", hint.Note, hint.advice())
	if strings.HasPrefix(hint.Command, "pairfob service ") {
		fmt.Fprintln(w, "Run in the foreground: pairfob run")
	}
	return admin.ErrNotRunning
}

func runForeground() error {
	store, err := state.Open("")
	if err != nil {
		return fmt.Errorf("state: %w", err)
	}
	sock, err := admin.SocketPathIn(store.Dir)
	if err != nil {
		return fmt.Errorf("admin socket: %w", err)
	}
	return runDaemon(store, sock)
}
