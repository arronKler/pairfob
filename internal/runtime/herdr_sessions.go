package runtime

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const sessionProbeTimeout = 250 * time.Millisecond

// SessionLister is the optional session-enumeration seam. Only Herdr
// implements it: the Fake runtime models a single session and has no
// sibling sessions to report, the same way it has no TerminalOpener.
type SessionLister interface {
	Sessions(ctx context.Context) ([]SessionInfo, error)
}

// SessionInfo describes one Herdr session known to this machine. Name is ""
// for the default session, matching SessionRef's convention so a caller can
// feed it straight back into any other RPC's session field unchanged.
type SessionInfo struct {
	Name    string
	Running bool
}

// Sessions lists the default session plus every named session under
// ConfigRoot/sessions, each probed for a live socket. It requires Multi:
// named sessions stay invisible to a daemon that has not opted in, mirroring
// socketFor's "multi-session disabled" gate so this never leaks session
// names an operator hasn't chosen to expose.
func (h *Herdr) Sessions(ctx context.Context) ([]SessionInfo, error) {
	if !h.Multi {
		return nil, &Fault{Code: CodeUnsupported, Operation: "session.list", Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: "multi-session disabled"}
	}
	entries, err := os.ReadDir(filepath.Join(h.ConfigRoot, "sessions"))
	if err != nil && !os.IsNotExist(err) {
		return nil, &Fault{Code: CodeInternal, Operation: "session.list", Outcome: OutcomeNotApplied, Retry: RetryReadSafe, SafeMessage: "failed to read session directory", Cause: err}
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !validSessionName.MatchString(entry.Name()) {
			continue
		}
		names = append(names, entry.Name())
	}

	sockets := make([]string, len(names)+1)
	sockets[0] = h.Socket
	for i, name := range names {
		sockets[i+1] = filepath.Join(h.ConfigRoot, "sessions", name, "herdr.sock")
	}
	running := probeSockets(ctx, sockets)

	sessions := make([]SessionInfo, len(names)+1)
	sessions[0] = SessionInfo{Name: "", Running: running[0]}
	for i, name := range names {
		sessions[i+1] = SessionInfo{Name: name, Running: running[i+1]}
	}
	sort.Slice(sessions[1:], func(i, j int) bool { return sessions[1:][i].Name < sessions[1:][j].Name })
	return sessions, nil
}

// probeSockets dials every socket concurrently and reports which accepted a
// connection within sessionProbeTimeout, bounded by ctx.
func probeSockets(ctx context.Context, sockets []string) []bool {
	results := make([]bool, len(sockets))
	var wg sync.WaitGroup
	for i, socket := range sockets {
		wg.Add(1)
		go func(i int, socket string) {
			defer wg.Done()
			results[i] = probeSocket(ctx, socket)
		}(i, socket)
	}
	wg.Wait()
	return results
}

func probeSocket(ctx context.Context, socket string) bool {
	deadline := time.Now().Add(sessionProbeTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	dialer := net.Dialer{Deadline: deadline}
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
