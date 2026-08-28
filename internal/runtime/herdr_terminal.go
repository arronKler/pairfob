package runtime

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxHerdrTerminalFrameBytes = 4 << 20

type herdrTerminal struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	events    chan TerminalEvent
	done      chan struct{}
	closeOnce sync.Once
	writeMu   sync.Mutex
}

type herdrTerminalRecord struct {
	Type     string `json:"type"`
	Sequence uint64 `json:"seq"`
	Encoding string `json:"encoding"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Full     bool   `json:"full"`
	Bytes    string `json:"bytes"`
	Reason   string `json:"reason"`
}

func (h *Herdr) OpenTerminal(ctx context.Context, open TerminalOpen) (TerminalController, error) {
	if !validResourceID.MatchString(open.PaneID) || !ValidTerminalSize(open.Cols, open.Rows) {
		return nil, invalidFault("terminal.open", "invalid terminal target or size")
	}
	binary, err := resolveHerdrBinary(h.TerminalBinary)
	if err != nil {
		return nil, err
	}
	args := make([]string, 0, 12)
	if open.Session.Name != "" {
		if !validSessionName.MatchString(open.Session.Name) {
			return nil, invalidFault("terminal.open", "invalid session name")
		}
		args = append(args, "--session", open.Session.Name)
	}
	args = append(args, "terminal", "session", "control", open.PaneID)
	if open.Takeover {
		args = append(args, "--takeover")
	}
	args = append(args, "--cols", strconv.Itoa(open.Cols), "--rows", strconv.Itoa(open.Rows))

	cmd := exec.Command(binary, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, terminalOpenFault(err.Error(), err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, terminalOpenFault(err.Error(), err)
	}
	stderr := &boundedText{remaining: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, terminalOpenFault(err.Error(), err)
	}
	controller := &herdrTerminal{
		cmd: cmd, stdin: stdin, events: make(chan TerminalEvent, 16), done: make(chan struct{}),
	}
	first := make(chan TerminalEvent, 1)
	go controller.read(stdout, first, stderr)

	select {
	case event := <-first:
		if event.Frame != nil {
			controller.events <- event
			return controller, nil
		}
		_ = controller.Close()
		reason := "terminal bridge closed before its first frame"
		if event.Closed != nil && event.Closed.Reason != "" {
			reason = event.Closed.Reason
		}
		return nil, terminalOpenFault(reason, event.Closed.Err)
	case <-ctx.Done():
		_ = controller.Close()
		return nil, &Fault{Code: CodeTimeout, Operation: "terminal.open", Outcome: OutcomeNotApplied, Retry: RetryUserOnly, SafeMessage: "terminal bridge did not become ready", Cause: ctx.Err()}
	}
}

func (t *herdrTerminal) Events() <-chan TerminalEvent { return t.events }

func (t *herdrTerminal) Input(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	return t.command("terminal.input", map[string]any{"type": "terminal.input", "bytes": base64.StdEncoding.EncodeToString(data)})
}

func (t *herdrTerminal) Resize(size TerminalResize) error {
	if !ValidTerminalSize(size.Cols, size.Rows) || size.CellWidthPX < 0 || size.CellHeightPX < 0 || size.CellWidthPX > 4096 || size.CellHeightPX > 4096 {
		return invalidFault("terminal.resize", "invalid terminal size")
	}
	return t.command("terminal.resize", map[string]any{
		"type": "terminal.resize", "cols": size.Cols, "rows": size.Rows,
		"cell_width_px": size.CellWidthPX, "cell_height_px": size.CellHeightPX,
	})
}

func (t *herdrTerminal) Scroll(scroll TerminalScroll) error {
	if (scroll.Direction != "up" && scroll.Direction != "down") || scroll.Lines < 1 || scroll.Lines > 160 ||
		(scroll.Source != "wheel" && scroll.Source != "page_key") || scroll.Modifiers < 0 || scroll.Modifiers > 255 {
		return invalidFault("terminal.scroll", "invalid terminal scroll")
	}
	command := map[string]any{
		"type": "terminal.scroll", "direction": scroll.Direction, "lines": scroll.Lines,
		"source": scroll.Source, "modifiers": scroll.Modifiers,
	}
	if scroll.Column != nil {
		command["column"] = *scroll.Column
	}
	if scroll.Row != nil {
		command["row"] = *scroll.Row
	}
	return t.command("terminal.scroll", command)
}

func (t *herdrTerminal) command(operation string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	select {
	case <-t.done:
		return terminalCommandFault(operation, errors.New("terminal bridge is closed"))
	default:
	}
	_, err = t.stdin.Write(append(raw, '\n'))
	if err != nil {
		return terminalCommandFault(operation, err)
	}
	return nil
}

func (t *herdrTerminal) Close() error {
	var closeErr error
	t.closeOnce.Do(func() {
		_ = t.command("terminal.close", map[string]any{"type": "terminal.release"})
		closeErr = t.stdin.Close()
		select {
		case <-t.done:
		case <-time.After(500 * time.Millisecond):
		}
		if t.cmd.Process != nil {
			_ = t.cmd.Process.Kill()
		}
	})
	return closeErr
}

func (t *herdrTerminal) read(stdout io.Reader, first chan<- TerminalEvent, stderr *boundedText) {
	defer close(t.events)
	defer close(t.done)
	defer func() { _ = t.cmd.Wait() }()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8<<20)
	firstPending := true
	emit := func(event TerminalEvent) {
		if firstPending {
			firstPending = false
			first <- event
			return
		}
		t.events <- event
	}
	for scanner.Scan() {
		var record herdrTerminalRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			emit(TerminalEvent{Closed: &TerminalClosed{Reason: "Herdr terminal bridge returned invalid JSON", Err: err}})
			return
		}
		switch record.Type {
		case "terminal.frame":
			if record.Sequence == 0 || record.Encoding != "ansi" || !ValidTerminalSize(record.Width, record.Height) {
				emit(TerminalEvent{Closed: &TerminalClosed{Reason: "Herdr terminal frame metadata is invalid"}})
				return
			}
			data, err := base64.StdEncoding.DecodeString(record.Bytes)
			if err != nil || len(data) > maxHerdrTerminalFrameBytes || base64.StdEncoding.EncodeToString(data) != record.Bytes {
				emit(TerminalEvent{Closed: &TerminalClosed{Reason: "Herdr terminal frame is invalid or too large", Err: err}})
				return
			}
			emit(TerminalEvent{Frame: &TerminalFrame{
				Sequence: record.Sequence, Width: record.Width, Height: record.Height, Full: record.Full, Data: data,
			}})
		case "terminal.closed":
			emit(TerminalEvent{Closed: &TerminalClosed{Reason: record.Reason}})
			return
		default:
			emit(TerminalEvent{Closed: &TerminalClosed{Reason: "Herdr terminal bridge returned an unknown record"}})
			return
		}
	}
	err := scanner.Err()
	reason := strings.TrimSpace(stderr.String())
	if reason == "" {
		reason = "Herdr terminal bridge closed"
	}
	event := TerminalEvent{Closed: &TerminalClosed{Reason: reason, Err: err}}
	if firstPending {
		first <- event
	} else {
		t.events <- event
	}
}

func resolveHerdrBinary(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if env := os.Getenv("HERDR_BIN"); env != "" {
		if info, err := os.Stat(env); err == nil && !info.IsDir() {
			return env, nil
		}
	}
	if found, err := exec.LookPath("herdr"); err == nil {
		return found, nil
	}
	var candidates []string
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".local", "bin", "herdr"))
	}
	candidates = append(candidates, "/usr/local/bin/herdr", "/opt/homebrew/bin/herdr")
	for _, path := range candidates {
		info, err := os.Stat(path)
		if err == nil && !info.IsDir() {
			return path, nil
		}
	}
	return "", &Fault{
		Code: CodeUnsupported, Operation: "terminal.open", Outcome: OutcomeNotApplied, Retry: RetryNever,
		SafeMessage: "Herdr CLI was not found; install Herdr on this computer",
	}
}

func terminalOpenFault(message string, cause error) error {
	lower := strings.ToLower(message)
	code := CodeOffline
	switch {
	case strings.Contains(lower, "not found"):
		code = CodeNotFound
	case strings.Contains(lower, "owner") || strings.Contains(lower, "attach") || strings.Contains(lower, "control") || strings.Contains(lower, "read in progress"):
		code = CodeConflict
	case strings.Contains(lower, "unsupported") || strings.Contains(lower, "unknown"):
		code = CodeUnsupported
	}
	return &Fault{Code: code, Operation: "terminal.open", Outcome: OutcomeNotApplied, Retry: RetryUserOnly, SafeMessage: message, Cause: cause}
}

func terminalCommandFault(operation string, cause error) error {
	return &Fault{
		Code: CodeOffline, Operation: operation, Outcome: OutcomeUnknown,
		Retry: RetryUserOnly, SafeMessage: "terminal bridge closed before the command was acknowledged", Cause: cause,
	}
}

type boundedText struct {
	mu        sync.Mutex
	text      strings.Builder
	remaining int
}

func (w *boundedText) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	if w.remaining > 0 {
		part := p
		if len(part) > w.remaining {
			part = part[:w.remaining]
		}
		_, _ = w.text.Write(part)
		w.remaining -= len(part)
	}
	return n, nil
}

func (w *boundedText) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.text.String()
}
