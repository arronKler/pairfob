package runtime

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
)

// herdr-core's framed connection. Channel 0 carries JSON-RPC as DATA frames;
// every other channel is a terminal attach stream whose DATA is raw bytes.
// Attach output is credited so the core's per-stream window stays open; a
// stream nobody watches is discarded. The hc process, its stderr and the
// socket never leave here.
const (
	coreRPCChannel  = 0
	coreKindData    = 0
	coreKindCredit  = 1
	coreKindClose   = 2
	coreKindResize  = 3
	coreFrameHeader = 9
	coreMaxFrame    = 1 << 20

	// A watched stream's reader gets this many frames of slack. A reader that
	// falls further behind is closed instead of stalling the connection's read
	// loop, which also serves JSON-RPC on the same pipe.
	coreStreamBuffer = 32
	// Frames can arrive before the caller that caused the stream has registered
	// its sink (the attach response is read from the pipe first). They wait here
	// in order, bounded, until the channel is watched or discarded.
	corePendingStreamBytes = 4 << 20
)

type coreTransport interface {
	Hello() coreHello
	Call(ctx context.Context, method string, params any, out any) error
	OpenInput(ctx context.Context, terminal string, cols, rows int) (channel uint32, err error)
	TypeInput(channel uint32, data []byte) error
	ResizeInput(channel uint32, cols, rows int) error
	CloseInput(channel uint32) error
	Close() error
}

// coreStreamItem is one frame of a non-RPC channel. A closed items channel is
// the core's CLOSE (or a dropped connection).
type coreStreamItem struct {
	kind    byte
	payload []byte
	cols    int
	rows    int
}

// corePushTransport delivers events.subscribe notifications on a channel.
// Optional so the shared transport surface stays small.
type corePushTransport interface {
	OpenEvents(ctx context.Context) (channel uint32, items <-chan coreStreamItem, err error)
}

// coreFrameTransport opens an attach stream whose raw frames are delivered
// instead of discarded. Optional for the same reason.
type coreFrameTransport interface {
	OpenOutput(ctx context.Context, terminal string, cols, rows int) (channel uint32, items <-chan coreStreamItem, err error)
}

type coreStreamSink struct {
	mu     sync.Mutex
	items  chan coreStreamItem
	closed bool
}

func newCoreStreamSink() *coreStreamSink {
	return &coreStreamSink{items: make(chan coreStreamItem, coreStreamBuffer)}
}

// deliver never blocks the read loop. A full sink is closed, which is how a
// stalled consumer learns to stop.
func (s *coreStreamSink) deliver(item coreStreamItem) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return true
	}
	select {
	case s.items <- item:
		return true
	default:
		return false
	}
}

func (s *coreStreamSink) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.items)
}

// coreStream is one non-RPC channel's local state. A nil sink means output is
// discarded; ended means the core closed it or the connection dropped.
type coreStream struct {
	sink  *coreStreamSink
	ended bool
}

type coreDial func(context.Context) (coreTransport, coreHello, error)

type coreTransportError struct {
	cause   error
	timeout bool
}

func (e *coreTransportError) Error() string { return e.cause.Error() }
func (e *coreTransportError) Unwrap() error { return e.cause }

type coreProtocolError struct {
	operation string
	message   string
}

func (e *coreProtocolError) Error() string { return e.message }

func coreProtocol(operation, message string) error {
	return &coreProtocolError{operation: operation, message: message}
}

// A stream the core already closed. The core sends CLOSE when the program
// exits; typing into that channel would otherwise be reported as applied.
type coreStreamClosedError struct{ channel uint32 }

func (e *coreStreamClosedError) Error() string { return "terminal input stream closed" }

type coreRPCError struct {
	Code    int
	Kind    string
	Message string
}

func (e *coreRPCError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Kind
}

type coreRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      uint64 `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type coreErrorWire struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    *struct {
		Kind string `json:"kind"`
	} `json:"data"`
}

func (e *coreErrorWire) rpcError() *coreRPCError {
	kind := ""
	if e.Data != nil {
		kind = e.Data.Kind
	}
	if kind == "" {
		kind = e.Message
	}
	return &coreRPCError{Code: e.Code, Kind: kind, Message: e.Message}
}

type coreResponseWire struct {
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *coreErrorWire  `json:"error"`
}

type coreHelloWire struct {
	Generation uint32 `json:"generation"`
	Version    string `json:"version"`
	Core       struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"core"`
	Framed  bool     `json:"framed"`
	Methods []string `json:"methods"`
}

type coreResponse struct {
	id     uint64
	result json.RawMessage
	err    error
}

type coreConn struct {
	rw     io.ReadWriteCloser
	stop   func()
	stderr *boundedBuffer
	r      *bufio.Reader
	hello  coreHello

	wmu     sync.Mutex
	callMu  sync.Mutex
	nextID  uint64
	pending chan coreResponse

	done      chan struct{}
	closeOnce sync.Once
	errMu     sync.Mutex
	readErr   error

	streamsMu     sync.Mutex
	streams       map[uint32]*coreStream
	pendingIn     map[uint32][]coreStreamItem
	pendingBytes  int
	streamsClosed bool
}

func newCoreConn(rw io.ReadWriteCloser, stop func(), stderr *boundedBuffer) *coreConn {
	return &coreConn{
		rw: rw, stop: stop, stderr: stderr, r: bufio.NewReaderSize(rw, 64<<10),
		pending: make(chan coreResponse, 1), done: make(chan struct{}),
		streams: make(map[uint32]*coreStream), pendingIn: make(map[uint32][]coreStreamItem),
	}
}

// start performs the plain hello and then hands the pipe to the framed reader.
// The hello reply itself is still one plain line; only later frames are framed.
func (c *coreConn) start(ctx context.Context) (coreHello, error) {
	type helloResult struct {
		hello coreHello
		err   error
	}
	results := make(chan helloResult, 1)
	go func() {
		hello, err := c.handshake()
		results <- helloResult{hello: hello, err: err}
	}()
	select {
	case result := <-results:
		if result.err != nil {
			_ = c.Close()
			return coreHello{}, result.err
		}
		c.hello = result.hello
		go c.readLoop()
		return result.hello, nil
	case <-ctx.Done():
		_ = c.Close()
		return coreHello{}, &coreTransportError{cause: ctx.Err(), timeout: true}
	}
}

func (c *coreConn) handshake() (coreHello, error) {
	request, err := json.Marshal(coreRequest{JSONRPC: "2.0", ID: 0, Method: "hello", Params: map[string]any{"framed": true}})
	if err != nil {
		return coreHello{}, coreProtocol("hello", "failed to encode the terminal core handshake")
	}
	if _, err := c.rw.Write(append(request, '\n')); err != nil {
		return coreHello{}, c.transportErr(err)
	}
	line, err := c.r.ReadBytes('\n')
	if err != nil {
		return coreHello{}, c.transportErr(err)
	}
	var envelope coreResponseWire
	if err := json.Unmarshal(line, &envelope); err != nil {
		return coreHello{}, coreProtocol("hello", "invalid terminal core handshake")
	}
	if envelope.Error != nil {
		return coreHello{}, envelope.Error.rpcError()
	}
	var wire coreHelloWire
	if len(envelope.Result) == 0 || json.Unmarshal(envelope.Result, &wire) != nil {
		return coreHello{}, coreProtocol("hello", "invalid terminal core handshake")
	}
	if !wire.Framed || wire.Generation == 0 {
		return coreHello{}, coreProtocol("hello", "terminal core did not switch to framed mode")
	}
	methods := make(map[string]bool, len(wire.Methods))
	for _, method := range wire.Methods {
		methods[method] = true
	}
	return coreHello{
		Generation: wire.Generation, Version: wire.Version, CoreID: wire.Core.ID,
		CoreName: wire.Core.Name, Framed: wire.Framed, Methods: methods,
	}, nil
}

func (c *coreConn) Hello() coreHello { return c.hello }

func (c *coreConn) Call(ctx context.Context, method string, params any, out any) error {
	c.callMu.Lock()
	defer c.callMu.Unlock()
	if err := ctx.Err(); err != nil {
		return &coreTransportError{cause: err, timeout: true}
	}
	select {
	case <-c.done:
		return c.closedError()
	default:
	}
	c.nextID++
	id := c.nextID
	payload, err := json.Marshal(coreRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return coreProtocol(method, "failed to encode the terminal core request")
	}
	if err := c.writeFrame(coreRPCChannel, coreKindData, payload); err != nil {
		c.shutdown(c.transportErr(err))
		return c.transportErr(err)
	}
	select {
	case response := <-c.pending:
		if response.id != id {
			fault := coreProtocol(method, "terminal core response id mismatch")
			c.shutdown(fault)
			return fault
		}
		if response.err != nil {
			return response.err
		}
		if out == nil {
			return nil
		}
		if len(response.result) == 0 || string(response.result) == "null" {
			fault := coreProtocol(method, "terminal core returned an empty result")
			c.shutdown(fault)
			return fault
		}
		if err := json.Unmarshal(response.result, out); err != nil {
			fault := coreProtocol(method, "invalid terminal core response")
			c.shutdown(fault)
			return fault
		}
		return nil
	case <-ctx.Done():
		c.shutdown(&coreTransportError{cause: ctx.Err(), timeout: true})
		return &coreTransportError{cause: ctx.Err(), timeout: true}
	case <-c.done:
		return c.closedError()
	}
}

func (c *coreConn) OpenInput(ctx context.Context, terminal string, cols, rows int) (uint32, error) {
	channel, err := c.openAttach(ctx, terminal, cols, rows)
	if err != nil {
		return 0, err
	}
	c.discardStream(channel)
	return channel, nil
}

// OpenOutput is OpenInput for a stream whose frames matter. The sink is
// installed only after terminal.attach answers, so frames the read loop already
// pulled off the pipe wait in order and are handed over here.
func (c *coreConn) OpenOutput(ctx context.Context, terminal string, cols, rows int) (uint32, <-chan coreStreamItem, error) {
	channel, err := c.openAttach(ctx, terminal, cols, rows)
	if err != nil {
		return 0, nil, err
	}
	return channel, c.watchStream(channel), nil
}

func (c *coreConn) openAttach(ctx context.Context, terminal string, cols, rows int) (uint32, error) {
	if cols < 0 || cols > 65535 || rows < 0 || rows > 65535 {
		return 0, coreProtocol("terminal.attach", "invalid terminal size")
	}
	var result struct {
		Channel  uint32       `json:"channel"`
		Terminal coreTerminal `json:"terminal"`
	}
	params := map[string]any{"terminal": terminal, "observe": false, "history": 0, "cols": cols, "rows": rows}
	if err := c.Call(ctx, "terminal.attach", params, &result); err != nil {
		return 0, err
	}
	if result.Channel == coreRPCChannel {
		return 0, coreProtocol("terminal.attach", "terminal core returned no attach channel")
	}
	if err := validateCoreTerminal("terminal.attach", result.Terminal); err != nil {
		c.discardStream(result.Channel)
		return 0, err
	}
	if result.Terminal.Address != terminal || result.Terminal.State != "live" {
		c.discardStream(result.Channel)
		return 0, coreProtocol("terminal.attach", "terminal core attached a different terminal")
	}
	return result.Channel, nil
}

func (c *coreConn) OpenEvents(ctx context.Context) (uint32, <-chan coreStreamItem, error) {
	var result struct {
		Channel *uint32 `json:"channel"`
	}
	if err := c.Call(ctx, "events.subscribe", map[string]any{}, &result); err != nil {
		return 0, nil, err
	}
	if result.Channel == nil || *result.Channel == coreRPCChannel {
		return 0, nil, coreProtocol("events.subscribe", "terminal core returned no event channel")
	}
	return *result.Channel, c.watchStream(*result.Channel), nil
}

// watchStream attaches a sink to a channel and replays anything that arrived
// before the sink existed. A channel the core already closed is closed at once.
func (c *coreConn) watchStream(channel uint32) <-chan coreStreamItem {
	sink := newCoreStreamSink()
	c.streamsMu.Lock()
	stream := c.streams[channel]
	if stream == nil {
		stream = &coreStream{}
		c.streams[channel] = stream
	}
	stream.sink = sink
	buffered, ended := c.takePending(channel), stream.ended || c.streamsClosed
	c.streamsMu.Unlock()
	for _, item := range buffered {
		if !sink.deliver(item) {
			break
		}
	}
	if ended {
		sink.close()
	}
	return sink.items
}

// discardStream keeps output flowing (and credited) without keeping it.
func (c *coreConn) discardStream(channel uint32) {
	c.streamsMu.Lock()
	stream := c.streams[channel]
	if stream == nil {
		stream = &coreStream{}
		c.streams[channel] = stream
	}
	stream.sink = nil
	c.takePending(channel)
	c.streamsMu.Unlock()
}

func (c *coreConn) takePending(channel uint32) []coreStreamItem {
	buffered := c.pendingIn[channel]
	if len(buffered) == 0 {
		delete(c.pendingIn, channel)
		return nil
	}
	delete(c.pendingIn, channel)
	for _, item := range buffered {
		c.pendingBytes -= len(item.payload)
	}
	return buffered
}

// endStream marks a channel closed, closes its sink, and drops queued frames.
// The core can also end a stream by itself; both paths meet here.
func (c *coreConn) endStream(channel uint32) {
	c.streamsMu.Lock()
	stream := c.streams[channel]
	if stream == nil {
		stream = &coreStream{}
		c.streams[channel] = stream
	}
	stream.ended = true
	sink := stream.sink
	c.takePending(channel)
	c.streamsMu.Unlock()
	if sink != nil {
		sink.close()
	}
}

func (c *coreConn) streamEnded(channel uint32) bool {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	stream := c.streams[channel]
	return stream != nil && stream.ended
}

// routeStream hands a frame to a watched sink. Frames for a channel that is
// not registered yet wait, bounded and in order, for OpenOutput/OpenEvents.
func (c *coreConn) routeStream(channel uint32, item coreStreamItem) {
	c.streamsMu.Lock()
	if c.streamsClosed {
		c.streamsMu.Unlock()
		return
	}
	stream := c.streams[channel]
	if stream == nil {
		if c.pendingBytes+len(item.payload) <= corePendingStreamBytes {
			c.pendingIn[channel] = append(c.pendingIn[channel], item)
			c.pendingBytes += len(item.payload)
		}
		c.streamsMu.Unlock()
		return
	}
	if stream.ended || stream.sink == nil {
		c.streamsMu.Unlock()
		return
	}
	sink := stream.sink
	c.streamsMu.Unlock()
	if !sink.deliver(item) {
		c.endStream(channel)
	}
}

func (c *coreConn) TypeInput(channel uint32, data []byte) error {
	if channel == coreRPCChannel {
		return coreProtocol("input", "invalid input channel")
	}
	if c.streamEnded(channel) {
		return &coreStreamClosedError{channel: channel}
	}
	if err := c.writeFrame(channel, coreKindData, data); err != nil {
		return c.transportErr(err)
	}
	return nil
}

// ResizeInput tells the core the attach viewer's grid. It matters when another
// viewer (a Herdr TUI) resized the shared terminal after this stream attached:
// typing without it would make this stale viewer the active leader.
func (c *coreConn) ResizeInput(channel uint32, cols, rows int) error {
	if channel == coreRPCChannel {
		return coreProtocol("input", "invalid input channel")
	}
	if cols <= 0 || cols > 65535 || rows <= 0 || rows > 65535 {
		return coreProtocol("input", "invalid terminal size")
	}
	if c.streamEnded(channel) {
		return &coreStreamClosedError{channel: channel}
	}
	payload := make([]byte, 4)
	binary.LittleEndian.PutUint16(payload[0:2], uint16(cols))
	binary.LittleEndian.PutUint16(payload[2:4], uint16(rows))
	if err := c.writeFrame(channel, coreKindResize, payload); err != nil {
		return c.transportErr(err)
	}
	return nil
}

func (c *coreConn) CloseInput(channel uint32) error {
	c.endStream(channel)
	if err := c.writeFrame(channel, coreKindClose, nil); err != nil {
		return c.transportErr(err)
	}
	return nil
}

func (c *coreConn) Close() error {
	c.shutdown(&coreTransportError{cause: errors.New("terminal core connection closed")})
	return nil
}

func (c *coreConn) writeFrame(channel uint32, kind byte, payload []byte) error {
	frame := make([]byte, coreFrameHeader+len(payload))
	binary.LittleEndian.PutUint32(frame[0:4], channel)
	frame[4] = kind
	binary.LittleEndian.PutUint32(frame[5:9], uint32(len(payload)))
	copy(frame[coreFrameHeader:], payload)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	written, err := c.rw.Write(frame)
	if err != nil {
		return err
	}
	if written != len(frame) {
		return io.ErrShortWrite
	}
	return nil
}

func (c *coreConn) readLoop() {
	for {
		header := make([]byte, coreFrameHeader)
		if _, err := io.ReadFull(c.r, header); err != nil {
			c.shutdown(c.transportErr(err))
			return
		}
		channel := binary.LittleEndian.Uint32(header[0:4])
		kind := header[4]
		length := binary.LittleEndian.Uint32(header[5:9])
		if length > coreMaxFrame {
			c.shutdown(coreProtocol("frame", "terminal core frame is too large"))
			return
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.r, payload); err != nil {
			c.shutdown(c.transportErr(err))
			return
		}
		switch kind {
		case coreKindData:
			if channel == coreRPCChannel {
				var envelope coreResponseWire
				if err := json.Unmarshal(payload, &envelope); err != nil {
					c.shutdown(coreProtocol("call", "invalid terminal core response"))
					return
				}
				if envelope.ID == 0 {
					continue
				}
				var responseErr error
				if envelope.Error != nil {
					responseErr = envelope.Error.rpcError()
				}
				select {
				case c.pending <- coreResponse{id: envelope.ID, result: envelope.Result, err: responseErr}:
				default:
					c.shutdown(coreProtocol("call", "unexpected terminal core response"))
					return
				}
				continue
			}
			if len(payload) > 0 {
				consumed := make([]byte, 4)
				binary.LittleEndian.PutUint32(consumed, uint32(len(payload)))
				if err := c.writeFrame(channel, coreKindCredit, consumed); err != nil {
					c.shutdown(c.transportErr(err))
					return
				}
				c.routeStream(channel, coreStreamItem{kind: coreKindData, payload: payload})
			}
		case coreKindClose:
			if channel != coreRPCChannel {
				c.endStream(channel)
			}
		case coreKindResize:
			// The core reports the display grid it settled on after a viewer
			// resize. The attach reader uses it for later frame sizes.
			if channel != coreRPCChannel && len(payload) == 4 {
				c.routeStream(channel, coreStreamItem{
					kind: coreKindResize,
					cols: int(binary.LittleEndian.Uint16(payload[0:2])),
					rows: int(binary.LittleEndian.Uint16(payload[2:4])),
				})
			}
		case coreKindCredit:
			// Server-side flow control needs no action here.
		}
	}
}

func (c *coreConn) shutdown(cause error) {
	c.closeOnce.Do(func() {
		c.errMu.Lock()
		c.readErr = cause
		c.errMu.Unlock()
		close(c.done)
		_ = c.rw.Close()
		if c.stop != nil {
			c.stop()
		}
		// Watched readers learn the pipe is gone instead of waiting forever.
		c.streamsMu.Lock()
		sinks := make([]*coreStreamSink, 0, len(c.streams))
		for channel, stream := range c.streams {
			stream.ended = true
			if stream.sink != nil {
				sinks = append(sinks, stream.sink)
			}
			delete(c.streams, channel)
		}
		c.streamsClosed = true
		c.pendingIn = make(map[uint32][]coreStreamItem)
		c.pendingBytes = 0
		c.streamsMu.Unlock()
		for _, sink := range sinks {
			sink.close()
		}
	})
}

func (c *coreConn) closedError() error {
	c.errMu.Lock()
	err := c.readErr
	c.errMu.Unlock()
	if err != nil {
		return err
	}
	return &coreTransportError{cause: errors.New("terminal core connection closed")}
}

func (c *coreConn) transportErr(cause error) error {
	cause = c.withStderr(cause)
	timeout := errors.Is(cause, context.DeadlineExceeded) || errors.Is(cause, context.Canceled) || isTimeout(cause)
	return &coreTransportError{cause: cause, timeout: timeout}
}

func (c *coreConn) withStderr(cause error) error {
	if c.stderr == nil {
		return cause
	}
	if text := strings.TrimSpace(c.stderr.String()); text != "" {
		return fmt.Errorf("%w: %s", cause, text)
	}
	return cause
}

type coreProcessPipes struct {
	reader io.ReadCloser
	writer io.WriteCloser
}

func (p *coreProcessPipes) Read(buffer []byte) (int, error)  { return p.reader.Read(buffer) }
func (p *coreProcessPipes) Write(buffer []byte) (int, error) { return p.writer.Write(buffer) }

func (p *coreProcessPipes) Close() error {
	writeErr := p.writer.Close()
	readErr := p.reader.Close()
	if writeErr != nil {
		return writeErr
	}
	return readErr
}

func spawnCoreTransport(ctx context.Context, command string) (coreTransport, coreHello, error) {
	cmd := exec.Command(command, "connect")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, coreHello{}, &coreTransportError{cause: err}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, coreHello{}, &coreTransportError{cause: err}
	}
	stderr := &boundedBuffer{max: 8 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, coreHello{}, &coreTransportError{cause: err}
	}
	pipes := &coreProcessPipes{reader: stdout, writer: stdin}
	conn := newCoreConn(pipes, func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}, stderr)
	hello, err := conn.start(ctx)
	if err != nil {
		_ = conn.Close()
		return nil, coreHello{}, err
	}
	return conn, hello, nil
}

// boundedBuffer keeps at most max bytes of the child's stderr so a noisy hc
// cannot grow without bound. The text only ever reaches the fault's Cause.
type boundedBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		trimmed := make([]byte, b.max)
		copy(trimmed, b.buf[len(b.buf)-b.max:])
		b.buf = trimmed
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}
