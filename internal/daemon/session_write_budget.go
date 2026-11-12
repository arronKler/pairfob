package daemon

import (
	"context"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

const sessionWriteWait = 10 * time.Second

// lockOutput returns holding the send lock only after transport admission.
// No sequence is consumed while waiting. Recheck under the lock because a
// competing response or an epoch switch can invalidate the observed capacity.
func (e *Engine) lockOutput(s *sess, plaintextBytes int, bulk bool) bool {
	if !bulk {
		// Keep the intent registered while the send lock is released for drain.
		// Otherwise a continuous terminal stream can repeatedly take newly freed
		// capacity before a larger interactive reply fits.
		s.changeInteractiveWait(1)
		defer s.changeInteractiveWait(-1)
	}
	var deadline time.Time
	for {
		s.lockSend(bulk)
		e.mu.Lock()
		active := s.sendEpochLive() && s.state == "established" && e.sessions[s.routeID] == s && s.s2c != nil
		link := s.link
		if link == nil {
			link = e.Conn
		}
		e.mu.Unlock()
		if !active {
			s.unlockSend(bulk)
			return false
		}
		budget, limited := link.(mux.WriteBudget)
		frameBytes := envelope.HeaderSize + 28 + plaintextBytes
		if !limited || budget.WriteReady(frameBytes) {
			return true
		}
		s.unlockSend(bulk)
		if deadline.IsZero() {
			deadline = time.Now().Add(sessionWriteWait)
		}
		ctx, cancel := context.WithDeadline(s.outputContext(), deadline)
		err := budget.WaitWritable(ctx, frameBytes)
		cancel()
		if err != nil {
			// Close only this pointer, never a replacement at the same route. Nothing
			// has been sealed, but the caller cannot publish its response on this link.
			s.sendMu.Lock()
			e.mu.Lock()
			current := s.link
			if current == nil {
				current = e.Conn
			}
			changed := current != link
			failed := !changed && s.epochFailed.CompareAndSwap(false, true)
			e.mu.Unlock()
			s.sendMu.Unlock()
			if changed {
				deadline = time.Time{}
				continue
			}
			if failed {
				go e.failTransportEpoch(s)
			}
			return false
		}
	}
}

// One cancellation parent per session avoids a goroutine for every congested
// terminal fragment. Teardown also cancels waits that begin concurrently.
func (s *sess) outputContext() context.Context {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.writeContext == nil {
		s.writeContext, s.cancelWrite = context.WithCancel(context.Background())
	}
	return s.writeContext
}

func (s *sess) stopWrites() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.writeContext == nil {
		s.writeContext, s.cancelWrite = context.WithCancel(context.Background())
	}
	s.cancelWrite()
}
