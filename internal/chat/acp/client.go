// Package acp is a client for the public Agent Client Protocol over an
// adapter's stdio. Frames are JSON-RPC 2.0 objects, one per line.
package acp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
)

const (
	// eventBuffer holds updates while a caller is busy applying the previous
	// one. A caller that stops reading must Close the client.
	eventBuffer = 128
	// stderrLimit is how much adapter stderr is kept for Exit.Stderr.
	stderrLimit = 32 << 10
)

// Options starts one adapter process.
type Options struct {
	// Command is the adapter executable and its arguments.
	Command []string
	// Dir is the adapter's working directory; empty inherits ours.
	Dir string
	// Env replaces the adapter environment; nil inherits ours.
	Env []string
}

// Client is one ACP connection to one adapter process.
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *os.File
	conn   *conn
	stderr *tailBuffer

	events    chan Event
	closingCh chan struct{}

	permMu      sync.Mutex
	permissions map[string]pendingPermission

	stateMu sync.Mutex
	readErr error
	waitErr error

	readDone  chan struct{}
	waited    chan struct{}
	closing   atomic.Bool
	closeOnce sync.Once
	exitOnce  sync.Once
	stdinOnce sync.Once
	closeErr  error
}

type pendingPermission struct {
	id json.RawMessage
}

// Start launches the adapter and begins reading its protocol stream.
func Start(opts Options) (*Client, error) {
	if len(opts.Command) == 0 || opts.Command[0] == "" {
		return nil, errors.New("acp: start needs a command")
	}

	cmd := exec.Command(opts.Command[0], opts.Command[1:]...)
	cmd.Dir = opts.Dir
	if opts.Env != nil {
		cmd.Env = opts.Env
	}

	// Own both pipes instead of using StdinPipe/StdoutPipe: exec closes those
	// when Wait returns, which can truncate a response still being read.
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("acp: stdin pipe: %w", err)
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		stdinRead.Close()
		stdinWrite.Close()
		return nil, fmt.Errorf("acp: stdout pipe: %w", err)
	}
	cmd.Stdin = stdinRead
	cmd.Stdout = stdoutWrite
	stderr := &tailBuffer{limit: stderrLimit}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		stdinRead.Close()
		stdinWrite.Close()
		stdoutRead.Close()
		stdoutWrite.Close()
		return nil, fmt.Errorf("acp: start %s: %w", opts.Command[0], err)
	}
	// The child owns its ends now.
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()

	client := &Client{
		cmd:         cmd,
		stdin:       stdinWrite,
		stdout:      stdoutRead,
		stderr:      stderr,
		events:      make(chan Event, eventBuffer),
		closingCh:   make(chan struct{}),
		permissions: make(map[string]pendingPermission),
		readDone:    make(chan struct{}),
		waited:      make(chan struct{}),
	}
	client.conn = newConn(stdinWrite, stdoutRead)
	client.conn.setHandlers(client.handleNotification, client.handleRequest)

	go client.readLoop()
	go client.waitLoop()
	go client.exitLoop()
	return client, nil
}

// Events returns the adapter event stream. It ends after exactly one EventExit;
// keep reading until it closes.
func (c *Client) Events() <-chan Event {
	return c.events
}

// Close stops the adapter. It is safe to call more than once.
func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		c.closing.Store(true)
		close(c.closingCh)
		c.conn.fail(ErrClosed)
		c.closeStdin()
		if c.cmd.Process != nil {
			if err := c.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				c.closeErr = err
			}
		}
		// A grandchild may hold the adapter's stdout open; closing our end
		// makes the read loop finish instead of waiting forever.
		_ = c.stdout.Close()
	})
	<-c.waited
	return c.closeErr
}

// Initialize negotiates the protocol version. This client declines the
// filesystem and terminal capabilities, so the adapter stays inside its own
// process for those.
func (c *Client) Initialize(ctx context.Context) (InitializeResult, error) {
	params := initializeParams{ProtocolVersion: 1}
	raw, err := c.conn.call(ctx, "initialize", params)
	if err != nil {
		return InitializeResult{}, err
	}
	var result InitializeResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return InitializeResult{}, fmt.Errorf("acp: initialize result: %w", err)
	}
	return result, nil
}

// NewSession opens a session rooted at cwd.
func (c *Client) NewSession(ctx context.Context, cwd string, mcpServers []any) (Session, error) {
	return c.openSession(ctx, "session/new", "", cwd, mcpServers)
}

// LoadSession resumes an existing session in cwd.
func (c *Client) LoadSession(ctx context.Context, sessionID, cwd string, mcpServers []any) (Session, error) {
	if sessionID == "" {
		return Session{}, errors.New("acp: load session needs a session id")
	}
	return c.openSession(ctx, "session/load", sessionID, cwd, mcpServers)
}

// Prompt sends one turn and waits for its stop reason. Updates and permission
// requests arrive on Events while it runs.
func (c *Client) Prompt(ctx context.Context, sessionID string, blocks []ContentBlock) (PromptResult, error) {
	if sessionID == "" {
		return PromptResult{}, errors.New("acp: prompt needs a session id")
	}
	if blocks == nil {
		blocks = []ContentBlock{}
	}
	raw, err := c.conn.call(ctx, "session/prompt", promptParams{SessionID: sessionID, Prompt: blocks})
	if err != nil {
		return PromptResult{}, err
	}
	var result PromptResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return PromptResult{}, fmt.Errorf("acp: prompt result: %w", err)
	}
	return result, nil
}

// Cancel asks the agent to stop the active turn. It is a notification.
func (c *Client) Cancel(sessionID string) error {
	if sessionID == "" {
		return errors.New("acp: cancel needs a session id")
	}
	return c.conn.notify("session/cancel", sessionParams{SessionID: sessionID})
}

// SetMode switches the session to one of the advertised modes.
func (c *Client) SetMode(ctx context.Context, sessionID, modeID string) error {
	if sessionID == "" || modeID == "" {
		return errors.New("acp: set mode needs a session id and a mode id")
	}
	_, err := c.conn.call(ctx, "session/set_mode", modeParams{SessionID: sessionID, ModeID: modeID})
	return err
}

// SetConfigOption changes one session setting such as the model.
func (c *Client) SetConfigOption(ctx context.Context, sessionID, configID, value string) error {
	if sessionID == "" || configID == "" {
		return errors.New("acp: set config option needs a session id and a config id")
	}
	_, err := c.conn.call(ctx, "session/set_config_option", configParams{SessionID: sessionID, ConfigID: configID, Value: value})
	return err
}

// AnswerPermission settles a pending permission request. An empty optionID
// answers with the cancelled outcome.
func (c *Client) AnswerPermission(requestID, optionID string) error {
	c.permMu.Lock()
	pending, ok := c.permissions[requestID]
	if ok {
		delete(c.permissions, requestID)
	}
	c.permMu.Unlock()
	if !ok {
		return ErrPermissionGone
	}
	outcome := PermissionOutcome{Outcome: "selected", OptionID: optionID}
	if optionID == "" {
		outcome = PermissionOutcome{Outcome: "cancelled"}
	}
	return c.conn.respond(pending.id, PermissionResponse{Outcome: outcome})
}

// ErrPermissionGone reports an answer for a request that is no longer pending.
var ErrPermissionGone = errors.New("acp: permission request is no longer pending")

func (c *Client) openSession(ctx context.Context, method, sessionID, cwd string, mcpServers []any) (Session, error) {
	if mcpServers == nil {
		mcpServers = []any{}
	}
	params := sessionOpenParams{SessionID: sessionID, Cwd: cwd, MCPServers: mcpServers}
	raw, err := c.conn.call(ctx, method, params)
	if err != nil {
		return Session{}, err
	}
	var session Session
	if err := json.Unmarshal(raw, &session); err != nil {
		return Session{}, fmt.Errorf("acp: %s result: %w", method, err)
	}
	return session, nil
}

// handleNotification turns session/update into Events. Other notifications
// are not part of the product contract and are dropped.
func (c *Client) handleNotification(method string, params json.RawMessage) {
	if method != "session/update" {
		return
	}
	var notification struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if err := json.Unmarshal(params, &notification); err != nil || len(notification.Update) == 0 {
		return
	}
	update := parseUpdate(notification.SessionID, notification.Update)
	c.emit(Event{Kind: EventUpdate, Update: &update})
}

// handleRequest answers agent-to-client requests. A permission request stays
// pending and unanswered until AnswerPermission; the agent is expected to wait.
func (c *Client) handleRequest(method string, id, params json.RawMessage) bool {
	if method != "session/request_permission" {
		return false
	}
	var request PermissionRequest
	if err := json.Unmarshal(params, &request); err != nil {
		_ = c.conn.respondError(id, codeInvalidParams, "invalid permission request")
		return true
	}
	request.RequestID = requestIDKey(id)
	c.permMu.Lock()
	c.permissions[request.RequestID] = pendingPermission{id: append(json.RawMessage(nil), id...)}
	c.permMu.Unlock()
	c.emit(Event{Kind: EventPermission, Permission: &request})
	return true
}

// emit delivers one event unless the client is closing, in which case the
// caller has stopped consuming and the read loop must not block.
func (c *Client) emit(event Event) {
	select {
	case c.events <- event:
	case <-c.closingCh:
	}
}

func (c *Client) readLoop() {
	err := c.conn.readLoop()
	c.stateMu.Lock()
	c.readErr = err
	c.stateMu.Unlock()
	close(c.readDone)
}

// waitLoop reaps the adapter. Waiting here rather than inside the read loop
// keeps stdout open until every buffered frame has been decoded.
func (c *Client) waitLoop() {
	err := c.cmd.Wait()
	c.stateMu.Lock()
	c.waitErr = err
	c.stateMu.Unlock()
	c.closeStdin()
	close(c.waited)
}

// exitLoop emits the single Exit event once the stream has ended and the
// process has been reaped.
func (c *Client) exitLoop() {
	<-c.readDone
	<-c.waited
	c.exitOnce.Do(func() {
		c.permMu.Lock()
		c.permissions = make(map[string]pendingPermission)
		c.permMu.Unlock()
		exit := Exit{Err: c.exitCause(), Code: c.exitCode(), Stderr: c.stderr.String()}
		c.events <- Event{Kind: EventExit, Exit: &exit}
		close(c.events)
	})
}

func (c *Client) exitCause() error {
	if c.closing.Load() {
		return ErrClosed
	}
	c.stateMu.Lock()
	readErr, waitErr := c.readErr, c.waitErr
	c.stateMu.Unlock()
	if waitErr != nil {
		return waitErr
	}
	return readErr
}

func (c *Client) exitCode() int {
	if c.cmd.ProcessState == nil {
		return -1
	}
	return c.cmd.ProcessState.ExitCode()
}

func (c *Client) closeStdin() {
	c.stdinOnce.Do(func() {
		_ = c.stdin.Close()
	})
}

// requestIDKey is the stable lookup key for an agent request id. A numeric id
// such as 0 and a string id such as "0" are distinct on the wire but both map
// to a readable string for AnswerPermission.
func requestIDKey(id json.RawMessage) string {
	var text string
	if json.Unmarshal(id, &text) == nil {
		return text
	}
	return string(id)
}

type initializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities clientCapabilities `json:"clientCapabilities"`
}

type clientCapabilities struct {
	FS       fsCapabilities `json:"fs"`
	Terminal bool           `json:"terminal"`
}

type fsCapabilities struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

type sessionOpenParams struct {
	SessionID  string `json:"sessionId,omitempty"`
	Cwd        string `json:"cwd"`
	MCPServers []any  `json:"mcpServers"`
}

type promptParams struct {
	SessionID string         `json:"sessionId"`
	Prompt    []ContentBlock `json:"prompt"`
}

type sessionParams struct {
	SessionID string `json:"sessionId"`
}

type modeParams struct {
	SessionID string `json:"sessionId"`
	ModeID    string `json:"modeId"`
}

type configParams struct {
	SessionID string `json:"sessionId"`
	ConfigID  string `json:"configId"`
	Value     string `json:"value"`
}

// tailBuffer keeps the last limit bytes written to it.
type tailBuffer struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if over := len(b.data) - b.limit; over > 0 {
		b.data = append(b.data[:0], b.data[over:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}
