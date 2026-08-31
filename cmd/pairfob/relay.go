package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"pairfob/internal/daemon"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/pairingqr"
	"pairfob/internal/wsnet"
)

const relayHeartbeatInterval = 25 * time.Second

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
	backoff := time.Second
	firstDone := false
	needNewPair := false
	for {
		conn, err := wsnet.DialProtocol(relayURL, wsnet.SubprotocolV2)
		if err != nil {
			log.Printf("relay dial failed; retry in %s: %v", backoff, err)
			time.Sleep(backoff)
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
			log.Printf("relay registration failed; retry in %s: %v", backoff, err)
			time.Sleep(backoff)
			backoff = nextBackoff(backoff)
			continue
		}
		link.set(conn)
		if !firstDone {
			first <- nil
			firstDone = true
		}
		backoff = time.Second
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
		heartbeatStop := make(chan struct{})
		heartbeatDone := make(chan struct{})
		go func() {
			runRelayHeartbeat(conn, relayHeartbeatInterval, heartbeatStop)
			close(heartbeatDone)
		}()
		for {
			frame, err := conn.Recv()
			if err != nil {
				log.Printf("relay disconnected; retry in %s: %v", backoff, err)
				break
			}
			daemon.TraceFrame("recv", frame)
			if err := link.pipe.Send(frame); err != nil {
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
		time.Sleep(backoff)
		backoff = nextBackoff(backoff)
	}
}

func nextBackoff(current time.Duration) time.Duration {
	current *= 2
	if current > 30*time.Second {
		return 30 * time.Second
	}
	return current
}
