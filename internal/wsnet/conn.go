package wsnet

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

type Conn struct {
	ws      *websocket.Conn
	writeMu sync.Mutex
}

func Wrap(ws *websocket.Conn) *Conn {
	ws.SetReadLimit(envelope.MaxPayload + envelope.HeaderSize + 64)
	return &Conn{ws: ws}
}

func (c *Conn) Send(f envelope.Frame) error {
	b, err := envelope.EncodeChecked(f)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteMessage(websocket.BinaryMessage, b)
}

func (c *Conn) Recv() (envelope.Frame, error) {
	return c.RecvWithin(60 * time.Second)
}

func (c *Conn) RecvWithin(timeout time.Duration) (envelope.Frame, error) {
	if timeout <= 0 {
		return envelope.Frame{}, errors.New("receive timeout must be positive")
	}
	c.ws.SetReadDeadline(time.Now().Add(timeout))
	messageType, b, err := c.ws.ReadMessage()
	if err != nil {
		return envelope.Frame{}, err
	}
	if messageType != websocket.BinaryMessage {
		return envelope.Frame{}, fmt.Errorf("websocket message type %d: binary required", messageType)
	}
	return envelope.Decode(b)
}

func (c *Conn) Close() { _ = c.ws.Close() }

var _ mux.Conn = (*Conn)(nil)

const (
	SubprotocolV1 = "pairfob.v1"
	SubprotocolV2 = "pairfob.v2"
)

// UpgraderFor negotiates a single WebSocket subprotocol.
func UpgraderFor(subprotocol string) websocket.Upgrader {
	return websocket.Upgrader{
		Subprotocols: []string{subprotocol},
		CheckOrigin:  CheckSameHostOrigin,
	}
}

// Upgrader is the pairfob.v1 wrapper used by the self-hosted relay.
var Upgrader = UpgraderFor(SubprotocolV1)

// CheckSameHostOrigin permits non-browser daemon/CLI connections (which omit
// Origin), while requiring browser websocket requests to originate from the
// same authority serving the PWA.
func CheckSameHostOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

// HasSubprotocol reports whether the client explicitly offered name.
// Gorilla otherwise permits an upgrade with no negotiated subprotocol.
func HasSubprotocol(r *http.Request, name string) bool {
	if name == "" {
		return false
	}
	for _, offered := range websocket.Subprotocols(r) {
		if strings.TrimSpace(offered) == name {
			return true
		}
	}
	return false
}

// HasV1Subprotocol reports whether the client explicitly offered pairfob.v1.
func HasV1Subprotocol(r *http.Request) bool {
	return HasSubprotocol(r, SubprotocolV1)
}

func Dial(rawURL string) (*Conn, error) {
	return DialProtocol(rawURL, SubprotocolV1)
}

func DialProtocol(rawURL, subprotocol string) (*Conn, error) {
	if strings.TrimSpace(subprotocol) == "" {
		return nil, errors.New("websocket subprotocol required")
	}
	tlsCfg, err := ClientTLSConfig()
	if err != nil {
		return nil, err
	}
	d := websocket.Dialer{Subprotocols: []string{subprotocol}, TLSClientConfig: tlsCfg}
	ws, _, err := d.Dial(rawURL, nil)
	if err != nil {
		return nil, err
	}
	if ws.Subprotocol() != subprotocol {
		_ = ws.Close()
		return nil, fmt.Errorf("relay did not negotiate %s subprotocol", subprotocol)
	}
	return Wrap(ws), nil
}
