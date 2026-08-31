package daemon

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"sync"
	"time"

	"pairfob/internal/audit"
	"pairfob/internal/crypto/aead"
	"pairfob/internal/crypto/canon"
	"pairfob/internal/crypto/sessionkeys"
	"pairfob/internal/crypto/spake2plus"
	"pairfob/internal/envelope"
	"pairfob/internal/journal"
	"pairfob/internal/mux"
	runtimeapi "pairfob/internal/runtime"
	"pairfob/internal/state"
)

// DirectAcceptor is the frame-level seam implemented by the WebRTC adapter in
// cmd/pairfob. Tests use an in-memory adapter; session crypto stays in daemon.
type DirectAcceptor interface {
	Accept(context.Context, string, func(mux.Conn, envelope.Frame), func(mux.Conn)) (string, mux.Conn, error)
}

type Device struct {
	ID                string
	PSK               []byte // 32 raw bytes
	Label             string
	UA                string
	Created           int64
	LastSeen          int64
	RevokedAt         *int64
	PushSubscriptions []state.PushSubscription
}

type pairingSlot struct {
	ref, code       string
	record          spake2plus.Record
	expiresAt       time.Time
	expiry          *time.Timer
	routeID         [16]byte
	attempt         string
	failures        int
	verifier        *spake2plus.Verifier
	keys            spake2plus.Keys
	sas             string
	confirmVerified bool
	confirmStarted  bool
	pairedAEAD      bool
	c2s, s2c        *aead.Direction
	deviceID        string
	psk             []byte
	confirmID       string
	acked           bool
	admitted        bool
	closed          bool
	admitCh         chan struct{}
	admitOnce       sync.Once
	readyCh         chan struct{}
	readyOnce       sync.Once
	loc             string
	locReady        bool
	openWait        chan error
	openOnce        sync.Once
}

type sess struct {
	routeID      [16]byte
	deviceID     string
	link         mux.Conn
	transport    string // relay or p2p
	upgradeFrom  [16]byte
	attemptID    string
	directBusy   bool
	c2s, s2c     *aead.Direction
	ephSk, ephPk [32]byte
	peerPk       [32]byte
	nonce        []byte
	hello1       sessionkeys.Hello1
	ts           int64
	state        string // resumehello|hello2|upgrade_ready|established|closed
	sendMu       sync.Mutex
	rpcQueue     chan rpcRequest
	rpcStop      chan struct{}
	rpcStopOnce  sync.Once
	terminalMu   sync.Mutex
	terminal     *terminalSlot
}

func (e *Engine) sendSessionFrame(s *sess, frame envelope.Frame) error {
	if s != nil && s.link != nil {
		return s.link.Send(frame)
	}
	return e.Conn.Send(frame)
}

type Engine struct {
	Hub       *mux.Hub
	Conn      mux.Conn
	RT        runtimeapi.Runtime
	PK        ed25519.PublicKey
	SK        ed25519.PrivateKey
	DaemonID  string
	Reconnect string
	Devices   map[string]*Device

	Store          *state.Store
	Audit          *audit.Logger
	Identity       state.Identity
	RelayURL       string
	VAPIDPublic    string
	VAPIDPrivate   []byte
	VAPIDSubject   string
	PushHTTPClient *http.Client
	PushEnabled    bool
	Direct         DirectAcceptor
	Journal        *journal.Reader

	pairOpenMu    sync.Mutex
	mu            sync.Mutex
	pair          *pairingSlot
	sessions      map[[16]byte]*sess
	byDevice      map[string][16]byte
	nonceByDevice map[string][]string
	helloGlobal   []time.Time
	helloByDevice map[string][]time.Time
	pushLast      map[string]time.Time
	pushSem       chan struct{}

	AutoAdmit  bool // explicit development/test injection
	Banner     io.Writer
	Origin     string
	PairingTTL time.Duration
	// MuxProtocol is 1 (self-hosted) or 2 (hosted). Zero means v1.
	MuxProtocol     int
	PairOpenAckWait time.Duration

	registerMu   sync.Mutex
	registerWait chan error
	credentialMu sync.Mutex

	operationMu  sync.Mutex
	operations   map[string]*operationRecord
	operationSeq uint64

	reads observeGroup
}

const PairingTTLDefault = 180 * time.Second

type PairingStatus struct {
	Ref, Code, URL, Loc string
	Admitted            bool
	Ready               bool
	Devices             int
	ExpiresAt           time.Time
}

func newEngine(hub *mux.Hub, conn mux.Conn, rt runtimeapi.Runtime, pk ed25519.PublicKey, sk ed25519.PrivateKey) *Engine {
	return &Engine{
		Hub: hub, Conn: conn, RT: rt, PK: pk, SK: sk,
		Devices: map[string]*Device{}, sessions: map[[16]byte]*sess{}, byDevice: map[string][16]byte{},
		nonceByDevice: map[string][]string{}, helloByDevice: map[string][]time.Time{},
		pushLast: map[string]time.Time{}, pushSem: make(chan struct{}, 8), PushHTTPClient: productionPushHTTPClient(),
		Journal: journal.NewDefault(), operations: map[string]*operationRecord{},
		Origin: "https://pairfob.com", Banner: os.Stdout, PairingTTL: PairingTTLDefault,
	}
}

// NewEngine creates an ephemeral engine for tests and explicit embedding.
func NewEngine(hub *mux.Hub, conn mux.Conn, rt runtimeapi.Runtime) *Engine {
	pk, sk, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return newEngine(hub, conn, rt, pk, sk)
}

// NewPersistentEngine restores (or creates) the daemon identity and devices.
func NewPersistentEngine(hub *mux.Hub, conn mux.Conn, rt runtimeapi.Runtime, store *state.Store, logger *audit.Logger) (*Engine, error) {
	if err := ValidateAllowedRoots(); err != nil {
		return nil, err
	}
	id, pk, sk, err := store.LoadOrCreateIdentity()
	if err != nil {
		return nil, err
	}
	relay, err := store.LoadRelay()
	if err != nil {
		return nil, err
	}
	rows, err := store.LoadDevices()
	if err != nil {
		return nil, err
	}
	operationRows, err := store.LoadOperations()
	if err != nil {
		return nil, err
	}
	vapid, err := store.LoadOrCreateVAPID(os.Getenv("PAIRFOB_VAPID_SUBJECT"))
	if err != nil {
		return nil, err
	}
	e := newEngine(hub, conn, rt, pk, sk)
	e.Store, e.Audit, e.Identity = store, logger, id
	e.DaemonID, e.Reconnect = id.DaemonID, relay.ReconnectToken
	e.RelayURL, e.VAPIDPublic = relay.URL, vapid.Public
	e.MuxProtocol = relay.Protocol
	e.VAPIDPrivate, err = canon.DecodeB64URL(vapid.Private)
	if err != nil || len(e.VAPIDPrivate) != 32 {
		return nil, errors.New("vapid.json contains invalid private key")
	}
	e.VAPIDSubject = vapid.Subject
	if err := e.restoreOperations(operationRows); err != nil {
		return nil, err
	}
	for _, row := range rows {
		psk, err := canon.DecodeB64URL(row.PSK)
		if err != nil || len(psk) != 32 || row.ID == "" {
			return nil, fmt.Errorf("devices.json contains invalid credential for %q", row.ID)
		}
		e.Devices[row.ID] = &Device{
			ID: row.ID, PSK: psk, Label: row.Label, UA: row.UA, Created: row.Created,
			LastSeen: row.LastSeen, RevokedAt: row.RevokedAt, PushSubscriptions: row.PushSubscriptions,
		}
	}
	return e, nil
}

func (e *Engine) muxVersion() int {
	if e.MuxProtocol == 2 {
		return 2
	}
	return 1
}

func (e *Engine) registrationFrame(join string) envelope.Frame {
	v := e.muxVersion()
	e.mu.Lock()
	daemonID, reconnect := e.DaemonID, e.Reconnect
	e.mu.Unlock()
	payload := map[string]any{
		"v": v, "op": "RegisterDaemon", "hostname": e.hostname(), "os": runtime.GOOS,
		"version": "0.1.0", "ed25519_pk": canon.B64URL(e.PK), "protocol": v,
	}
	if daemonID != "" && reconnect != "" {
		payload["daemon_id"] = daemonID
		payload["reconnect_token"] = reconnect
	} else if v != 2 {
		payload["join_token"] = join
	}
	return envelope.JSON(envelope.TypHELLO_DAEMON, [16]byte{}, payload)
}

func (e *Engine) updateReconnectCredential(token string) {
	e.mu.Lock()
	e.Reconnect = token
	e.mu.Unlock()
}

// RotateReconnectCredential serializes a control-plane rotation with relay
// registration, then publishes the already-durable replacement in memory.
func (e *Engine) RotateReconnectCredential(rotate func() (string, error)) error {
	e.credentialMu.Lock()
	defer e.credentialMu.Unlock()
	token, err := rotate()
	if err != nil {
		return err
	}
	e.updateReconnectCredential(token)
	return nil
}

func (e *Engine) applyRegistration(payload []byte) error {
	var resp struct {
		OK             bool   `json:"ok"`
		DaemonID       string `json:"daemon_id"`
		ReconnectToken string `json:"reconnect_token"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil {
		return fmt.Errorf("bad register response: %w", err)
	}
	if !resp.OK || resp.DaemonID == "" || len(resp.DaemonID) > 128 || resp.ReconnectToken == "" || len(resp.ReconnectToken) > 256 {
		return errors.New("relay rejected registration")
	}
	e.mu.Lock()
	e.DaemonID, e.Reconnect = resp.DaemonID, resp.ReconnectToken
	if e.Identity.Created == 0 {
		e.Identity.Created = time.Now().Unix()
	}
	e.Identity.DaemonID = resp.DaemonID
	e.mu.Unlock()
	if err := e.persistRegistration(); err != nil {
		return err
	}
	e.audit("relay_registered", map[string]any{"daemon_id": resp.DaemonID})
	return nil
}

// Register performs initial synchronous registration before RecvLoop starts.
func (e *Engine) Register(join string) error {
	if err := e.Conn.Send(e.registrationFrame(join)); err != nil {
		return err
	}
	return e.loopUntil(func(f envelope.Frame) (bool, error) {
		if f.Typ == envelope.TypERROR {
			return true, errors.New("relay registration error")
		}
		if f.Typ != envelope.TypHELLO_DAEMON {
			return false, nil
		}
		return true, e.applyRegistration(f.Payload)
	})
}

// RegisterExchange registers directly on a freshly dialed relay connection.
// It is used before the connection is exposed to the normal frame pumps, which
// guarantees RegisterDaemon is the first frame after every reconnect.
func (e *Engine) RegisterExchange(join string, exchange func(envelope.Frame) (envelope.Frame, error)) error {
	e.credentialMu.Lock()
	defer e.credentialMu.Unlock()
	resp, err := exchange(e.registrationFrame(join))
	if err != nil {
		return err
	}
	if resp.Typ == envelope.TypERROR {
		var body envelope.ErrorBody
		_ = json.Unmarshal(resp.Payload, &body)
		if body.Code == "" {
			body.Code = "relay registration error"
		}
		return errors.New(body.Code)
	}
	if resp.Typ != envelope.TypHELLO_DAEMON {
		return fmt.Errorf("unexpected registration frame type %d", resp.Typ)
	}
	return e.applyRegistration(resp.Payload)
}

// RegisterLive registers a reconnected transport while RecvLoop remains active.
func (e *Engine) RegisterLive(join string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	wait := make(chan error, 1)
	e.registerMu.Lock()
	if e.registerWait != nil {
		e.registerMu.Unlock()
		return errors.New("registration already in flight")
	}
	e.registerWait = wait
	e.registerMu.Unlock()
	defer func() {
		e.registerMu.Lock()
		if e.registerWait == wait {
			e.registerWait = nil
		}
		e.registerMu.Unlock()
	}()
	if err := e.Conn.Send(e.registrationFrame(join)); err != nil {
		return err
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case err := <-wait:
		return err
	case <-t.C:
		return errors.New("relay registration timeout")
	}
}

func (e *Engine) signalRegistration(err error) {
	e.registerMu.Lock()
	w := e.registerWait
	e.registerMu.Unlock()
	if w != nil {
		select {
		case w <- err:
		default:
		}
	}
}

func (e *Engine) loopUntil(pred func(envelope.Frame) (bool, error)) error {
	p, ok := e.Conn.(*mux.Pipe)
	if !ok {
		return errors.New("engine transport does not support receive")
	}
	for {
		f, ok := p.Recv()
		if !ok {
			return errors.New("closed")
		}
		done, err := pred(f)
		if done {
			return err
		}
		e.Handle(f)
	}
}

func (e *Engine) RecvLoop(stop <-chan struct{}) {
	p, ok := e.Conn.(*mux.Pipe)
	if !ok {
		return
	}
	for {
		select {
		case <-stop:
			return
		default:
		}
		f, ok := p.Recv()
		if !ok {
			return
		}
		e.Handle(f)
	}
}

func (e *Engine) Handle(f envelope.Frame) {
	switch f.Typ {
	case envelope.TypHELLO_DAEMON:
		e.signalRegistration(e.applyRegistration(f.Payload))
	case envelope.TypPAIR_OPEN:
		e.handlePairOpenAck(f)
	case envelope.TypPAIR_ATTACHED:
		e.handlePairAttached(f)
	case envelope.TypSESSION_BOUND:
		e.handleSessionBound(f)
	case envelope.TypFWD:
		e.handleFWD(f)
	case envelope.TypERROR:
		if f.RouteID != ([16]byte{}) {
			e.closeSession(f.RouteID, "", false)
		} else {
			e.handleRelayError(f)
		}
	}
}

func (e *Engine) handleRelayError(f envelope.Frame) {
	var body envelope.ErrorBody
	if json.Unmarshal(f.Payload, &body) != nil {
		e.signalRegistration(errors.New("relay registration error"))
		return
	}
	if body.Code == "index_unavailable" {
		e.failPairOpen(body.PairRef, errors.New("index_unavailable"))
		return
	}
	if body.Code != "pairing_replaced" && body.Code != "pairing_expired" {
		e.signalRegistration(errors.New("relay registration error"))
		return
	}
	e.mu.Lock()
	pair := e.pair
	if pair == nil || pair.closed || body.PairRef == "" || pair.ref != body.PairRef {
		e.mu.Unlock()
		return
	}
	e.burnPairLocked(pair)
	e.mu.Unlock()
	if e.Banner != nil {
		_, _ = fmt.Fprintf(e.Banner, "Pairing closed: %s\n", body.Code)
	}
	e.audit(body.Code, map[string]any{"pair_ref": body.PairRef})
}

func (e *Engine) handleFWD(f envelope.Frame) {
	e.mu.Lock()
	pair := e.pair
	s := e.sessions[f.RouteID]
	e.mu.Unlock()
	if pair != nil && !pair.closed && f.RouteID == pair.routeID {
		e.handlePairFWD(f, pair)
		return
	}
	if s != nil {
		e.handleSessFWD(f, s)
	}
}

func (e *Engine) hostname() string {
	if e.Identity.Hostname != "" {
		return e.Identity.Hostname
	}
	host, _ := os.Hostname()
	if host == "" {
		return "localhost"
	}
	return host
}

func (e *Engine) HostName() string { return e.hostname() }

func (e *Engine) RuntimeKind() string {
	switch e.RT.(type) {
	case *runtimeapi.Fake:
		return "fake"
	case *runtimeapi.Offline:
		return "offline"
	case *runtimeapi.Herdr:
		return "herdr"
	default:
		return "unknown"
	}
}

func (e *Engine) pairedCountLocked() int {
	n := 0
	for _, device := range e.Devices {
		if device != nil && device.RevokedAt == nil {
			n++
		}
	}
	return n
}

func (e *Engine) audit(op string, fields map[string]any) {
	if e.Audit != nil {
		e.Audit.Event(op, fields)
	}
}
