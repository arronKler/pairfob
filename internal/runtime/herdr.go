package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Herdr talks to a Herdr Unix socket. Herdr wire names and version differences
// stay inside this adapter.
type Herdr struct {
	Socket         string
	ConfigRoot     string
	Multi          bool
	TerminalBinary string
	launchServer   herdrServerLauncher
	bootstrapPoll  time.Duration
}

func DefaultSocket() string {
	if p := os.Getenv("HERDR_SOCKET_PATH"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "herdr", "herdr.sock")
}

// Open constructs the configured runtime without requiring Herdr to be live.
// Herdr calls dial the socket independently, so a daemon that starts first can
// recover when Herdr becomes available later. The fake runtime remains behind
// an explicit development flag so production never reports simulated success.
func Open(devFake, multi bool) (rt Runtime, source string, err error) {
	if devFake {
		return NewFake(), "fake:explicit-dev", nil
	}
	sock := DefaultSocket()
	if sock == "" {
		return nil, "herdr:offline", &Fault{Code: CodeOffline, Outcome: OutcomeNotApplied, Retry: RetryReadSafe, SafeMessage: "cannot resolve Herdr socket"}
	}
	h := NewHerdr(sock)
	h.Multi = multi
	return h, fmt.Sprintf("herdr:%s", sock), nil
}

func NewHerdr(socket string) *Herdr {
	home, _ := os.UserHomeDir()
	return &Herdr{
		Socket: socket, ConfigRoot: filepath.Join(home, ".config", "herdr"),
		launchServer: launchPersistentHerdrServer, bootstrapPoll: 100 * time.Millisecond,
	}
}

type rpcEnv struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var (
	validSessionName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	validAgentName   = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	validResourceID  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
)

func validOptionalResourceID(value string) bool {
	return value == "" || validResourceID.MatchString(value)
}

func (h *Herdr) socketFor(session SessionRef) (string, error) {
	if session.Name == "" {
		return h.Socket, nil
	}
	if !h.Multi {
		return "", &Fault{Code: CodeUnsupported, Operation: "session", Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: "multi-session disabled"}
	}
	if !validSessionName.MatchString(session.Name) || session.Name == "." || session.Name == ".." {
		return "", invalidFault("session", "invalid session name")
	}
	return filepath.Join(h.ConfigRoot, "sessions", session.Name, "herdr.sock"), nil
}

func (h *Herdr) call(ctx context.Context, session SessionRef, method string, params any, mutating bool) (json.RawMessage, error) {
	return h.callWithTimeout(ctx, session, method, params, mutating, 8*time.Second)
}

func (h *Herdr) callWithTimeout(ctx context.Context, session SessionRef, method string, params any, mutating bool, timeout time.Duration) (json.RawMessage, error) {
	socket, err := h.socketFor(session)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: 2 * time.Second}
	c, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, transportFault(method, err, mutating, false)
	}
	defer c.Close()
	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = c.SetDeadline(deadline)
	req, err := json.Marshal(map[string]any{"id": "pairfob", "method": method, "params": params})
	if err != nil {
		return nil, &Fault{Code: CodeInternal, Operation: method, Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: "failed to encode Herdr request", Cause: err}
	}
	written, err := c.Write(append(req, '\n'))
	if err != nil {
		return nil, transportFault(method, err, mutating, written > 0)
	}
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 0, 64*1024), 2<<20)
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return nil, transportFault(method, err, mutating, true)
		}
		return nil, transportFault(method, fmt.Errorf("herdr eof"), mutating, true)
	}
	if err := ctx.Err(); err != nil {
		return nil, transportFault(method, err, mutating, true)
	}
	var env rpcEnv
	if err := json.Unmarshal(sc.Bytes(), &env); err != nil {
		return nil, responseFault(method, "invalid Herdr response", err, mutating)
	}
	if env.ID != "pairfob" {
		return nil, responseFault(method, "Herdr response id mismatch", nil, mutating)
	}
	if (env.Error == nil) == (len(env.Result) == 0 || string(env.Result) == "null") {
		return nil, responseFault(method, "Herdr response must contain exactly one of result or error", nil, mutating)
	}
	if env.Error != nil {
		return nil, herdrFault(method, env.Error.Code, env.Error.Message)
	}
	return env.Result, nil
}

func transportFault(operation string, cause error, mutating, sent bool) error {
	code := CodeOffline
	if cause == context.DeadlineExceeded || isTimeout(cause) {
		code = CodeTimeout
	}
	outcome := OutcomeNotApplied
	retry := RetryReadSafe
	if mutating {
		retry = RetryUserOnly
		if sent {
			outcome = OutcomeUnknown
		}
	}
	return &Fault{Code: code, Operation: operation, Outcome: outcome, Retry: retry, SafeMessage: cause.Error(), Cause: cause}
}

func responseFault(operation, message string, cause error, mutating bool) error {
	outcome := OutcomeNotApplied
	retry := RetryReadSafe
	if mutating {
		outcome = OutcomeUnknown
		retry = RetryUserOnly
	}
	return &Fault{Code: CodeInternal, Operation: operation, Outcome: outcome, Retry: retry, SafeMessage: message, Cause: cause}
}

func isTimeout(err error) bool {
	type timeout interface{ Timeout() bool }
	value, ok := err.(timeout)
	return ok && value.Timeout()
}

func herdrFault(operation, code, message string) error {
	mapped := CodeInternal
	switch {
	case strings.Contains(code, "not_found"):
		mapped = CodeNotFound
	case code == "agent_blocked":
		mapped = CodeBlocked
	case code == "invalid_key":
		mapped = CodeKey
	case strings.Contains(code, "not_ready") || strings.Contains(code, "not_idle") || strings.Contains(code, "unavailable") || strings.Contains(code, "busy") || code == "agent_launch_pending":
		mapped = CodeNotReady
	case strings.Contains(code, "invalid") || strings.Contains(code, "empty") || strings.Contains(code, "missing"):
		mapped = CodeInvalid
	case strings.Contains(code, "conflict") || strings.Contains(code, "taken") || strings.Contains(code, "already"):
		mapped = CodeConflict
	case strings.Contains(code, "timeout"):
		mapped = CodeTimeout
	case strings.Contains(code, "unsupported") || code == "not_implemented" || code == "protocol_mismatch":
		mapped = CodeUnsupported
	case strings.Contains(code, "rate"):
		mapped = CodeRateLimited
	}
	if message == "" {
		message = code
	}
	return &Fault{Code: mapped, Operation: operation, Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: message}
}

func invalidFault(operation, message string) error {
	return &Fault{Code: CodeInvalid, Operation: operation, Outcome: OutcomeNotApplied, Retry: RetryNever, SafeMessage: message}
}
