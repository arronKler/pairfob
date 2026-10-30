package runtime

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

// Core adapts herdr-core's machine/terminal RPC to the Pairfob Runtime seam.
// The wire vocabulary, the hc child process, attach channels and credit stay
// inside this adapter; callers only see descriptors, snapshots, views and
// receipts. Named core sessions are not part of this unit.
type Core struct {
	command string
	dial    coreDial

	opMu sync.Mutex

	connMu sync.Mutex
	conn   coreTransport
	hello  coreHello
	closed bool
	// Event streams own dedicated connections; Close ends them with the Core.
	eventStreams map[*coreEventStream]struct{}

	inputMu   sync.Mutex
	inputs    map[string]*coreInputStream
	inputIdle time.Duration
}

func NewCore(command string) *Core {
	if strings.TrimSpace(command) == "" {
		command = DefaultHC()
	}
	return &Core{command: command, inputs: make(map[string]*coreInputStream), inputIdle: coreInputIdle}
}

func coreDefaultSession(operation string, session SessionRef) error {
	if session.Name == "" {
		return nil
	}
	return unsupported(operation, "named terminal core sessions are not supported")
}

func (c *Core) dialer() coreDial {
	if c.dial != nil {
		return c.dial
	}
	return func(ctx context.Context) (coreTransport, coreHello, error) {
		return spawnCoreTransport(ctx, c.command)
	}
}

func (c *Core) connection(ctx context.Context) (coreTransport, coreHello, error) {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	if c.closed {
		return nil, coreHello{}, &Fault{
			Code: CodeOffline, Operation: "connect", Outcome: OutcomeNotApplied,
			Retry: RetryReadSafe, SafeMessage: "the terminal core runtime is closed",
		}
	}
	if c.conn != nil {
		return c.conn, c.hello, nil
	}
	conn, hello, err := c.dialer()(ctx)
	if err != nil {
		return nil, coreHello{}, coreFault("connect", err, false, false)
	}
	c.conn, c.hello = conn, hello
	return conn, hello, nil
}

// endCall maps a failed wire operation and drops the cached connection when
// the failure means the pipe is unusable. A later call reconnects; mutations
// are never replayed.
func (c *Core) endCall(conn coreTransport, operation string, err error, mutating, sent bool) error {
	fault := coreFault(operation, err, mutating, sent)
	var transportErr *coreTransportError
	var protocolErr *coreProtocolError
	if errors.As(err, &transportErr) || errors.As(err, &protocolErr) {
		c.dropConnection(conn)
	}
	var streamErr *coreStreamClosedError
	if errors.As(err, &streamErr) {
		c.forgetCoreInputChannel(streamErr.channel)
	}
	return fault
}

func (c *Core) dropConnection(conn coreTransport) {
	c.connMu.Lock()
	if c.conn == conn {
		c.conn = nil
		c.hello = coreHello{}
	}
	c.connMu.Unlock()
	_ = conn.Close()
	c.forgetCoreInputs()
}

func (c *Core) Describe(ctx context.Context, session SessionRef) (Descriptor, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	if err := coreDefaultSession("describe", session); err != nil {
		return Descriptor{}, err
	}
	conn, hello, err := c.connection(ctx)
	if err != nil {
		return Descriptor{}, err
	}
	descriptor := Descriptor{Runtime: "herdr-core", Version: hello.Version, Protocol: int(hello.Generation)}
	var templates coreTemplatesResult
	if err := conn.Call(ctx, "templates.list", nil, &templates); err != nil {
		fault := c.endCall(conn, "describe", err, false, false)
		var rpcErr *coreRPCError
		if !errors.As(err, &rpcErr) {
			// An answer we cannot read means the cached hello is all we have.
			return Descriptor{}, fault
		}
	} else {
		descriptor.AgentKinds = coreAgentKinds(templates)
	}
	descriptor.Capabilities = coreCapabilities(hello.Methods)
	return descriptor, nil
}

func (c *Core) Close() error {
	c.connMu.Lock()
	if c.closed {
		c.connMu.Unlock()
		return nil
	}
	c.closed = true
	conn := c.conn
	c.conn = nil
	c.hello = coreHello{}
	streams := make([]*coreEventStream, 0, len(c.eventStreams))
	for stream := range c.eventStreams {
		streams = append(streams, stream)
	}
	c.eventStreams = nil
	c.connMu.Unlock()
	// Event streams close their own dedicated connections, outside connMu so
	// their Close can forget themselves here.
	for _, stream := range streams {
		_ = stream.Close()
	}
	c.closeCoreInputs()
	if conn != nil {
		return conn.Close()
	}
	return nil
}

func (c *Core) trackEventStream(stream *coreEventStream) bool {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	if c.closed {
		return false
	}
	if c.eventStreams == nil {
		c.eventStreams = make(map[*coreEventStream]struct{})
	}
	c.eventStreams[stream] = struct{}{}
	return true
}

func (c *Core) forgetEventStream(stream *coreEventStream) {
	c.connMu.Lock()
	delete(c.eventStreams, stream)
	c.connMu.Unlock()
}

func coreClosedFault(operation string) *Fault {
	return &Fault{
		Code: CodeOffline, Operation: operation, Outcome: OutcomeNotApplied,
		Retry: RetryReadSafe, SafeMessage: "the terminal core runtime is closed",
	}
}

var (
	_ Runtime         = (*Core)(nil)
	_ EventSubscriber = (*Core)(nil)
	_ TerminalOpener  = (*Core)(nil)
)
