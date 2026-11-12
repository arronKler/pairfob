package mux

import (
	"context"
	"errors"
	"time"

	"pairfob/internal/envelope"
)

// One maximum envelope plus control headroom keeps the wire busy without a
// long encrypted backlog. Two 96 KiB terminal parts also fit with their headers.
// The channel retains its existing hard frame cap for handshake/control users.
const pipeControlHeadroom = 4 * 1024
const pipeWriteBudget = envelope.HeaderSize + envelope.MaxPayload + pipeControlHeadroom

func (p *Pipe) writeReady(frameBytes int) (bool, error) {
	select {
	case <-p.closed:
		return false, errClosed
	case <-p.peer.closed:
		return false, errClosed
	default:
	}
	if frameBytes < envelope.HeaderSize || frameBytes > envelope.HeaderSize+envelope.MaxPayload {
		return false, errors.New("invalid pipe write budget")
	}
	return p.peer.queued.Load()+int64(frameBytes) <= pipeWriteBudget && len(p.peer.ch) < cap(p.peer.ch), nil
}
func (p *Pipe) WriteReady(frameBytes int) bool { ready, _ := p.writeReady(frameBytes); return ready }
func (p *Pipe) WaitWritable(ctx context.Context, frameBytes int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ready, err := p.writeReady(frameBytes)
	if err != nil || ready {
		return err
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.closed:
			return errClosed
		case <-p.peer.closed:
			return errClosed
		case <-p.peer.drained:
		case <-ticker.C:
		}
		ready, err = p.writeReady(frameBytes)
		if err != nil || ready {
			return err
		}
	}
}

var _ WriteBudget = (*Pipe)(nil)
