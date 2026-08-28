package mux

import (
	"sync"
	"time"

	"pairfob/internal/envelope"
)

type Pipe struct {
	ch     chan envelope.Frame
	peer   *Pipe
	closed chan struct{}
	once   sync.Once
}

func NewPipePair(buf int) (*Pipe, *Pipe) {
	if buf < 4 {
		buf = 16
	}
	a := &Pipe{ch: make(chan envelope.Frame, buf), closed: make(chan struct{})}
	b := &Pipe{ch: make(chan envelope.Frame, buf), closed: make(chan struct{})}
	a.peer, b.peer = b, a
	return a, b
}

func (p *Pipe) Send(f envelope.Frame) error {
	select {
	case <-p.closed:
		return errClosed
	case <-p.peer.closed:
		return errClosed
	default:
	}
	select {
	case p.peer.ch <- f:
		return nil
	case <-p.closed:
		return errClosed
	case <-p.peer.closed:
		return errClosed
	}
}

func drain(p *Pipe) (envelope.Frame, bool) {
	select {
	case f := <-p.ch:
		return f, true
	default:
		return envelope.Frame{}, false
	}
}

func (p *Pipe) Recv() (envelope.Frame, bool) {
	select {
	case f := <-p.ch:
		return f, true
	case <-p.closed:
		return drain(p)
	}
}

func (p *Pipe) RecvTimeout(d time.Duration) (envelope.Frame, bool) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case f := <-p.ch:
		return f, true
	case <-p.closed:
		if f, ok := drain(p); ok {
			return f, true
		}
		return envelope.Frame{}, false
	case <-t.C:
		return envelope.Frame{}, false
	}
}

func (p *Pipe) Close() {
	p.once.Do(func() { close(p.closed) })
}

type closedErr string

func (e closedErr) Error() string { return string(e) }

const errClosed closedErr = "pipe closed"
