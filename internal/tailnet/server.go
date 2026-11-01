// Package tailnet hosts the direct Pairfob HTTP and WebSocket endpoint on the
// machine's Tailscale address.
package tailnet

import (
	"bufio"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"pairfob/internal/daemon"
	"pairfob/internal/envelope"
	"pairfob/internal/mux"
)

//go:embed ui/generated/*
var uiFiles embed.FS

const subprotocol = "pairfob.v2"
const maxClients = 32
const maxWSMessage = envelope.HeaderSize + envelope.MaxPayload

var tailnetIPv4 = net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

type Gateway struct {
	mu       sync.Mutex
	engine   *daemon.Engine
	routes   map[[16]byte]*client
	clients  chan struct{}
	listener net.Listener
	server   *http.Server
	origin   string
}

type client struct {
	ws     *websocket.Conn
	remote string
	mu     sync.Mutex
	route  [16]byte
	bound  bool
	closed bool
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

// New starts the loopback server. Call Attach before accepting any pairing.
// HealthBody is the constant body of GET /v2/health, shared with the optional
// loopback health listener.
const HealthBody = `{"ok":true,"protocol":2}`

func New(listener net.Listener, origin string) *Gateway {
	g := &Gateway{listener: listener, origin: strings.TrimRight(origin, "/"), routes: map[[16]byte]*client{}, clients: make(chan struct{}, maxClients)}
	g.server = &http.Server{Handler: g.handler(), ReadHeaderTimeout: 5 * time.Second}
	return g
}

func (g *Gateway) Attach(engine *daemon.Engine) { g.engine = engine }

func (g *Gateway) Origin() string { return g.origin }

func (g *Gateway) Serve() error { return g.server.Serve(g.listener) }

func (g *Gateway) Close() { _ = g.server.Close() }

func (g *Gateway) Send(frame envelope.Frame) error {
	if err := envelope.Validate(frame); err != nil {
		return err
	}
	g.mu.Lock()
	c := g.routes[frame.RouteID]
	g.mu.Unlock()
	if c == nil {
		// PAIR_CLOSE has no route and is only a local state transition here.
		if frame.Typ == envelope.TypPAIR_CLOSE {
			return nil
		}
		return errors.New("tailnet route is not attached")
	}
	return c.send(frame)
}

func (g *Gateway) handler() http.Handler {
	static, err := fs.Sub(uiFiles, "ui/generated")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(static))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorded := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			log.Printf("tailnet http remote=%s method=%s path=%s status=%d", r.RemoteAddr, r.Method, r.URL.Path, recorded.status)
		}()
		w = recorded
		g.securityHeaders(w)
		switch r.URL.Path {
		case "/api/config":
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"protocol":2,"build":"tailnet","p2p":false,"push":false,"release_check":false,"telemetry":false}`))
		case "/v2/health":
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(HealthBody))
		case "/v2/ws":
			w.Header().Set("Cache-Control", "no-store")
			g.serveWS(w, r)
		default:
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if r.URL.Path == "/pair" || r.URL.Path == "/pair/" {
				// Let http.FileServer resolve / to index.html itself. Rewriting / to
				// /index.html would trigger its canonical redirect loop.
				r.URL.Path = "/"
			}
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				// Vite content-addresses production assets. Keeping these immutable
				// avoids re-downloading the application on each phone visit while
				// the HTML shell and all API responses remain private/no-store.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-store")
			}
			files.ServeHTTP(w, r)
		}
	})
}

func (g *Gateway) securityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' wss: https:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
}

func (g *Gateway) serveWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Query().Get("role") != "client" || r.URL.Query().Get("daemon_id") == "" {
		log.Printf("tailnet websocket rejected remote=%s reason=bad_request", r.RemoteAddr)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if !sameTailnetOrigin(r.Header.Get("Origin"), g.origin) {
		log.Printf("tailnet websocket rejected remote=%s reason=origin origin=%q", r.RemoteAddr, r.Header.Get("Origin"))
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	select {
	case g.clients <- struct{}{}:
		defer func() { <-g.clients }()
	default:
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	upgrader := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{subprotocol},
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	if ws.Subprotocol() != subprotocol {
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseProtocolError, "pairfob.v2 required"), time.Now())
		_ = ws.Close()
		return
	}
	ws.SetReadLimit(maxWSMessage)
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Minute))
	c := &client{ws: ws, remote: r.RemoteAddr}
	g.serveClient(c)
}

func sameTailnetOrigin(raw, own string) bool {
	if raw == "" {
		return false
	}
	if raw == own {
		return true
	}
	// A PWA hosted by another daemon in this tailnet may retain a multi-computer
	// catalog. Tailscale still authenticates transport peers, and Pairfob then
	// authenticates each device through PAKE or DeviceHello.
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Port() != "18474" || !tailnetIPv4.Contains(net.ParseIP(u.Hostname())) {
		return false
	}
	return true
}

func (g *Gateway) serveClient(c *client) {
	defer g.drop(c)
	stage := "hello"
	defer func() { log.Printf("tailnet websocket closed remote=%s stage=%s", c.remote, stage) }()
	for {
		kind, bytes, err := c.ws.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage {
			if err != nil {
				log.Printf("tailnet websocket read remote=%s stage=%s error=%v", c.remote, stage, err)
			}
			return
		}
		_ = c.ws.SetReadDeadline(time.Now().Add(2 * time.Minute))
		frame, err := envelope.Decode(bytes)
		if err != nil {
			log.Printf("tailnet websocket frame remote=%s stage=%s error=%v", c.remote, stage, err)
			g.reject(c, frame.RouteID, "bad_frame", err.Error())
			return
		}
		switch stage {
		case "hello":
			if frame.Typ != envelope.TypHELLO_CLIENT || frame.RouteID != ([16]byte{}) || !validHello(frame.Payload) {
				g.reject(c, frame.RouteID, "unbound", "HELLO_CLIENT must be first")
				return
			}
			stage = "attach"
		case "attach":
			if frame.Typ == envelope.TypPAIR_ATTACH {
				if !g.attachPair(c, frame) {
					return
				}
				stage = "bound"
			} else if frame.Typ == envelope.TypSESSION_ATTACH {
				if !g.attachSession(c, frame) {
					return
				}
				stage = "bound"
			} else {
				g.reject(c, frame.RouteID, "unbound", "PAIR_ATTACH or SESSION_ATTACH required")
				return
			}
		case "bound":
			if frame.Typ == envelope.TypPING {
				if len(frame.Payload) != 8 {
					g.reject(c, frame.RouteID, "bad_frame", "invalid heartbeat")
					return
				}
				frame.Typ = envelope.TypPONG
				_ = c.send(frame)
				continue
			}
			if frame.Typ != envelope.TypFWD || frame.RouteID != c.route {
				g.reject(c, frame.RouteID, "bad_frame", "frame is not bound to this route")
				return
			}
			if g.engine != nil {
				g.engine.Handle(frame)
			}
		}
	}
}

func validHello(payload []byte) bool {
	var body struct{ V, Protocol int }
	return json.Unmarshal(payload, &body) == nil && body.V == 2 && body.Protocol == 2
}

func (g *Gateway) attachPair(c *client, frame envelope.Frame) bool {
	var body struct {
		V         int    `json:"v"`
		PairRef   string `json:"pair_ref"`
		PairToken string `json:"pair_token"`
	}
	if json.Unmarshal(frame.Payload, &body) != nil || body.V != 2 || !validPairRef(body.PairRef) || !validTicket(body.PairToken) || g.engine == nil {
		g.reject(c, frame.RouteID, "unpaired", "pairing invitation is invalid")
		return false
	}
	route, err := randomRoute()
	if err != nil {
		g.reject(c, frame.RouteID, "unpaired", "could not create pairing route")
		return false
	}
	g.bind(c, route)
	attempt := "tailnet_" + hex.EncodeToString(route[:])
	if !g.engine.ClaimTailnetPairing(strings.ToLower(body.PairRef), body.PairToken, attempt, route) {
		g.unbind(c)
		g.reject(c, frame.RouteID, "unpaired", "pairing invitation expired or was used")
		return false
	}
	return c.send(envelope.JSON(envelope.TypPAIR_ATTACHED, route, map[string]any{
		"v": 2, "daemon_id": g.engine.DaemonID, "pair_ref": strings.ToLower(body.PairRef), "attempt_id": attempt,
	})) == nil
}

func (g *Gateway) attachSession(c *client, frame envelope.Frame) bool {
	var body struct {
		V        int    `json:"v"`
		DaemonID string `json:"daemon_id"`
	}
	if json.Unmarshal(frame.Payload, &body) != nil || body.V != 2 || g.engine == nil || body.DaemonID != g.engine.DaemonID {
		g.reject(c, frame.RouteID, "unpaired", "daemon is unavailable")
		return false
	}
	route, err := randomRoute()
	if err != nil {
		g.reject(c, frame.RouteID, "unpaired", "could not create session route")
		return false
	}
	g.bind(c, route)
	g.engine.Handle(envelope.JSON(envelope.TypSESSION_BOUND, route, map[string]any{"v": 2, "route_id": hex.EncodeToString(route[:])}))
	return c.send(envelope.JSON(envelope.TypSESSION_BOUND, route, map[string]any{"v": 2, "route_id": hex.EncodeToString(route[:])})) == nil
}

func (g *Gateway) bind(c *client, route [16]byte) {
	g.mu.Lock()
	c.route, c.bound = route, true
	g.routes[route] = c
	g.mu.Unlock()
}

func (g *Gateway) unbind(c *client) {
	g.mu.Lock()
	if c.bound && g.routes[c.route] == c {
		delete(g.routes, c.route)
	}
	c.bound = false
	g.mu.Unlock()
}

func (g *Gateway) drop(c *client) {
	g.mu.Lock()
	route, bound := c.route, c.bound
	if bound && g.routes[route] == c {
		delete(g.routes, route)
	}
	c.bound = false
	g.mu.Unlock()
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	if bound && g.engine != nil {
		g.engine.DropTailnetRoute(route)
		g.engine.Handle(envelope.JSON(envelope.TypERROR, route, envelope.ErrorBody{Code: "disconnected", RouteID: hex.EncodeToString(route[:]), Message: "client disconnected"}))
	}
	_ = c.ws.Close()
}

func (g *Gateway) reject(c *client, route [16]byte, code, message string) {
	_ = c.send(envelope.JSON(envelope.TypERROR, route, envelope.ErrorBody{Code: code, Message: message}))
}

func (c *client) send(frame envelope.Frame) error {
	data, err := envelope.EncodeChecked(frame)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("client closed")
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteMessage(websocket.BinaryMessage, data)
}

func (c *client) Send(frame envelope.Frame) error { return c.send(frame) }

func (c *client) Close() { _ = c.ws.Close() }

func randomRoute() ([16]byte, error) {
	var route [16]byte
	_, err := rand.Read(route[:])
	return route, err
}

func validPairRef(ref string) bool {
	if len(ref) != 32 {
		return false
	}
	_, err := hex.DecodeString(ref)
	return err == nil
}

func validTicket(ticket string) bool {
	if len(ticket) != 32 {
		return false
	}
	_, err := hex.DecodeString(ticket)
	return err == nil
}

var _ mux.Conn = (*Gateway)(nil)
var _ mux.Conn = (*client)(nil)

func Listen(address string) (net.Listener, error) {
	if !strings.Contains(address, "://") {
		host, port, err := net.SplitHostPort(address)
		if err != nil || port == "" || host == "" || !allowedListenIP(net.ParseIP(host)) {
			return nil, errors.New("invalid listener address")
		}
		return net.Listen("tcp", address)
	}
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "http" || u.Port() == "" || !allowedListenIP(net.ParseIP(u.Hostname())) {
		return nil, errors.New("invalid direct tailnet endpoint")
	}
	return net.Listen("tcp", u.Host)
}

func allowedListenIP(ip net.IP) bool {
	return ip != nil && (ip.IsLoopback() || tailnetIPv4.Contains(ip))
}

// ValidateOrigin keeps the advertised pairing URL on the exact tailnet socket.
func ValidateOrigin(origin string, listener net.Listener) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Port() != "18474" || !tailnetIPv4.Contains(net.ParseIP(u.Hostname())) {
		return errors.New("PAIRFOB_ORIGIN must be the direct Tailscale IPv4 address on port 18474")
	}
	if u.Host != listener.Addr().String() {
		return errors.New("PAIRFOB_ORIGIN must match the listener address")
	}
	return nil
}

func LocalURL(listener net.Listener) string {
	return fmt.Sprintf("http://%s", listener.Addr().String())
}
