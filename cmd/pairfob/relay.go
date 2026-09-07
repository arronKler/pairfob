package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"math/rand/v2"
	"os"
	"sync"
	"time"

	"pairfob/internal/daemon"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/pairingqr"
	"pairfob/internal/wsnet"
)

const (
	relayHeartbeatInterval = 25 * time.Second
	relayStableConnection  = 10 * time.Second
	relayInitialBackoff    = time.Second
	relayMaxBackoff        = 30 * time.Second
)

type relayRetry struct {
	now    func() time.Time
	jitter func(time.Duration) time.Duration
	wait   func(time.Duration, <-chan struct{}) bool
}

func liveRelayRetry() relayRetry {
	return relayRetry{now: time.Now, jitter: jitterBackoff, wait: waitRelayBackoff}
}

type relayHeartbeatConn interface {
	Send(envelope.Frame) error
	Close()
}

func runRelayHeartbeat(conn relayHeartbeatConn, interval time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var counter uint64
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			counter++
			payload := make([]byte, 8)
			binary.BigEndian.PutUint64(payload, counter)
			if err := conn.Send(envelope.Frame{Version: 1, Typ: envelope.TypPING, Payload: payload}); err != nil {
				conn.Close()
				return
			}
		}
	}
}

type relayLink struct {
	pipe    *mux.Pipe
	mu      sync.Mutex
	current *wsnet.Conn
}

func newRelayLink(pipe *mux.Pipe) *relayLink {
	return &relayLink{pipe: pipe}
}

func (l *relayLink) set(conn *wsnet.Conn) {
	l.mu.Lock()
	l.current = conn
	l.mu.Unlock()
}

func (l *relayLink) clear(conn *wsnet.Conn) {
	l.mu.Lock()
	if l.current == conn {
		l.current = nil
	}
	l.mu.Unlock()
}

func (l *relayLink) get() *wsnet.Conn {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.current
}

func (l *relayLink) sendLoop() {
	for {
		frame, ok := l.pipe.Recv()
		if !ok {
			return
		}
		conn := l.get()
		if conn == nil {
			// Connection-scoped frames are never queued across reconnect.
			continue
		}
		daemon.TraceFrame("send", frame)
		if err := conn.Send(frame); err != nil {
			l.clear(conn)
			conn.Close()
			// A frame that may have partially crossed a failed connection is
			// never retried; especially SendText/SendKeys must be at-most-once.
		}
	}
}

func runRelay(link *relayLink, eng *daemon.Engine, relayURL, join string, first chan<- error) {
	runRelayWith(link, eng, relayURL, join, first, nil, liveRelayRetry())
}

func runRelayWith(link *relayLink, eng *daemon.Engine, relayURL, join string, first chan<- error, stop <-chan struct{}, retry relayRetry) {
	if retry.now == nil {
		retry.now = time.Now
	}
	if retry.jitter == nil {
		retry.jitter = jitterBackoff
	}
	if retry.wait == nil {
		retry.wait = waitRelayBackoff
	}
	backoff := relayInitialBackoff
	firstDone := false
	needNewPair := false
	for {
		select {
		case <-stop:
			return
		default:
		}
		conn, err := wsnet.DialProtocol(relayURL, wsnet.SubprotocolV2)
		if err != nil {
			if !retryAfter(retry, "relay dial failed", backoff, err, stop) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		if err := eng.RegisterExchange(join, func(frame envelope.Frame) (envelope.Frame, error) {
			if err := conn.Send(frame); err != nil {
				return envelope.Frame{}, err
			}
			return conn.Recv()
		}); err != nil {
			conn.Close()
			if !retryAfter(retry, "relay registration failed", backoff, err, stop) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
		link.set(conn)
		if !firstDone {
			first <- nil
			firstDone = true
		}
		if needNewPair {
			offer, err := eng.OpenPairing("")
			if err != nil {
				log.Printf("open replacement pairing: %v", err)
			} else {
				fmt.Println("\nRelay reconnected; pairing code rotated:")
				_ = pairingqr.Print(os.Stdout, pairingqr.Offer{Code: offer.Code, Ref: offer.Ref, URL: offer.URL, Loc: offer.Loc}, time.Until(offer.ExpiresAt))
				log.Printf("relay reconnected; pairing rotated pair_ref=%s", offer.Ref)
				needNewPair = false
			}
		} else {
			eng.RefreshPairing()
		}
		connectedAt := retry.now()
		heartbeatStop := make(chan struct{})
		heartbeatDone := make(chan struct{})
		go func() {
			runRelayHeartbeat(conn, relayHeartbeatInterval, heartbeatStop)
			close(heartbeatDone)
		}()
		var recvErr error
		for {
			frame, err := conn.Recv()
			if err != nil {
				recvErr = err
				break
			}
			daemon.TraceFrame("recv", frame)
			if err := link.pipe.Send(frame); err != nil {
				close(heartbeatStop)
				<-heartbeatDone
				link.clear(conn)
				conn.Close()
				return
			}
		}
		close(heartbeatStop)
		<-heartbeatDone
		link.clear(conn)
		conn.Close()
		if eng.ResetTransport() {
			needNewPair = true
		}
		delay, next := relayReconnectBackoff(retry.now().Sub(connectedAt), backoff)
		if !retryAfter(retry, "relay disconnected", delay, recvErr, stop) {
			return
		}
		backoff = next
	}
}

func retryAfter(retry relayRetry, label string, delay time.Duration, err error, stop <-chan struct{}) bool {
	delay = retry.jitter(delay)
	log.Printf("%s; retry in %s: %v", label, delay, err)
	return retry.wait(delay, stop)
}

// A link that was healthy gets one immediate reconnect attempt. A connection
// that never became stable keeps the exponential backoff to avoid a hot loop.
// Registration success does not reset delay: only a stable live link does.
func relayReconnectBackoff(connectedFor, current time.Duration) (time.Duration, time.Duration) {
	if connectedFor >= relayStableConnection {
		return 0, relayInitialBackoff
	}
	if current < relayInitialBackoff {
		current = relayInitialBackoff
	}
	return current, nextBackoff(current)
}

func nextBackoff(current time.Duration) time.Duration {
	current *= 2
	if current > relayMaxBackoff {
		return relayMaxBackoff
	}
	return current
}

func jitterBackoff(d time.Duration) time.Duration {
	return jitterBackoffN(d, rand.Int64N)
}

func jitterBackoffN(d time.Duration, intN func(int64) int64) time.Duration {
	if d <= 0 {
		return 0
	}
	if d > relayMaxBackoff {
		d = relayMaxBackoff
	}
	half := d / 2
	span := int64(d-half) + 1
	if span <= 1 {
		return clampRelayDelay(d)
	}
	extra := intN(span)
	if extra < 0 {
		extra = 0
	}
	if extra >= span {
		extra = span - 1
	}
	return clampRelayDelay(half + time.Duration(extra))
}

func clampRelayDelay(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	if d > relayMaxBackoff {
		return relayMaxBackoff
	}
	return d
}

func waitRelayBackoff(d time.Duration, stop <-chan struct{}) bool {
	if d <= 0 {
		select {
		case <-stop:
			return false
		default:
			return true
		}
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	if stop == nil {
		<-timer.C
		return true
	}
	select {
	case <-stop:
		return false
	case <-timer.C:
		return true
	}
}
