package acp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	// maxLineBytes is the largest JSON-RPC frame accepted from an adapter.
	// One frame is one line; a longer line is a protocol error.
	maxLineBytes = 16 << 20

	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

// ErrClosed reports that the adapter is no longer reachable.
var ErrClosed = errors.New("acp: adapter connection closed")

// RPCError is an error response the agent sent for a client request.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if len(e.Data) > 0 {
		return fmt.Sprintf("acp: rpc error %d: %s: %s", e.Code, e.Message, e.Data)
	}
	return fmt.Sprintf("acp: rpc error %d: %s", e.Code, e.Message)
}

type pendingResponse struct {
	result json.RawMessage
	err    *RPCError
}

// rpcRequest is a client-to-agent request. Ids are allocated by conn.
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// rpcNotification is a client-to-agent notification: no id, no response.
type rpcNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// rpcResponse settles an agent-to-client request. ID keeps the agent's raw id
// so a numeric id such as 0 is answered with the same JSON type.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// incomingFrame is any object an agent writes. A frame is a response when it
// has an id and no method, a request when it has both, and a notification
// when it has only a method.
type incomingFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *RPCError       `json:"error"`
}

// conn owns ACP framing: newline-delimited JSON-RPC, request ids, response
// correlation, and dispatch of agent notifications and requests.
type conn struct {
	in  io.Writer
	out io.Reader

	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan pendingResponse
	closed  bool
	exitErr error
	done    chan struct{}

	onNotification func(method string, params json.RawMessage)
	onRequest      func(method string, id, params json.RawMessage) bool
}

func newConn(in io.Writer, out io.Reader) *conn {
	return &conn{in: in, out: out, done: make(chan struct{})}
}

// setHandlers installs the dispatch callbacks. It must be called before the
// read loop starts.
func (c *conn) setHandlers(onNotification func(string, json.RawMessage), onRequest func(string, json.RawMessage, json.RawMessage) bool) {
	c.onNotification = onNotification
	c.onRequest = onRequest
}

// call sends one request and waits for the response with the same id.
func (c *conn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, responses, err := c.addPending()
	if err != nil {
		return nil, err
	}
	request := rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}
	if err := c.write(request); err != nil {
		c.removePending(id)
		return nil, err
	}
	select {
	case response := <-responses:
		if response.err != nil {
			return nil, response.err
		}
		return response.result, nil
	case <-ctx.Done():
		c.removePending(id)
		return nil, ctx.Err()
	case <-c.done:
		c.removePending(id)
		return nil, c.closedError()
	}
}

// notify sends a notification: the agent must not answer it.
func (c *conn) notify(method string, params any) error {
	return c.write(rpcNotification{JSONRPC: "2.0", Method: method, Params: params})
}

// respond answers an agent-to-client request.
func (c *conn) respond(id json.RawMessage, result any) error {
	return c.write(rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
}

func (c *conn) respondError(id json.RawMessage, code int, message string) error {
	return c.write(rpcResponse{JSONRPC: "2.0", ID: id, Error: &RPCError{Code: code, Message: message}})
}

// readLoop decodes one JSON object per line until the adapter closes stdout
// or the line cap is exceeded.
func (c *conn) readLoop() error {
	scanner := bufio.NewScanner(c.out)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		c.dispatch(line)
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	c.fail(err)
	return err
}

// dispatch routes one decoded line. Lines that are not JSON objects are
// ignored: adapters sometimes write banner text to stdout, and a corrupt line
// must not take down a live session.
func (c *conn) dispatch(line []byte) {
	var frame incomingFrame
	if err := json.Unmarshal(line, &frame); err != nil {
		return
	}
	hasID := len(frame.ID) > 0 && !bytes.Equal(frame.ID, []byte("null"))
	switch {
	case frame.Method != "" && hasID:
		if handler := c.onRequest; handler != nil && handler(frame.Method, frame.ID, frame.Params) {
			return
		}
		_ = c.respondError(frame.ID, codeMethodNotFound, "method not found: "+frame.Method)
	case frame.Method != "":
		if handler := c.onNotification; handler != nil {
			handler(frame.Method, frame.Params)
		}
	case hasID:
		c.settle(frame.ID, frame.Result, frame.Error)
	}
}

// settle hands a response to the call waiting for its id.
func (c *conn) settle(id json.RawMessage, result json.RawMessage, rpcErr *RPCError) {
	var number int64
	if json.Unmarshal(id, &number) != nil {
		return
	}
	c.mu.Lock()
	responses, ok := c.pending[number]
	if ok {
		delete(c.pending, number)
	}
	c.mu.Unlock()
	if !ok {
		return
	}
	select {
	case responses <- pendingResponse{result: result, err: rpcErr}:
	default:
	}
}

// write serializes one frame. Every write holds writeMu so concurrent callers
// never interleave bytes on the adapter's stdin.
func (c *conn) write(frame any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("acp: encode frame: %w", err)
	}
	data = append(data, '\n')

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	if _, err := c.in.Write(data); err != nil {
		c.fail(fmt.Errorf("acp: write: %w", err))
		return fmt.Errorf("acp: write: %w", err)
	}
	return nil
}

func (c *conn) addPending() (int64, chan pendingResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		if c.exitErr != nil {
			return 0, nil, c.exitErr
		}
		return 0, nil, ErrClosed
	}
	c.nextID++
	responses := make(chan pendingResponse, 1)
	if c.pending == nil {
		c.pending = make(map[int64]chan pendingResponse)
	}
	c.pending[c.nextID] = responses
	return c.nextID, responses, nil
}

func (c *conn) removePending(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// fail closes the connection once and wakes every waiting call.
func (c *conn) fail(err error) {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		c.exitErr = err
		close(c.done)
	}
	c.mu.Unlock()
}

func (c *conn) closedError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.exitErr != nil {
		return c.exitErr
	}
	return ErrClosed
}
