package endpoint

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/hub"
	"pairfob/internal/chat/protocol"
)

// stubAgent is the smallest hub.Agent: prompts block until the test answers.
type stubAgent struct {
	events  chan acp.Event
	replies chan acp.PromptResult
	done    chan struct{}
	once    sync.Once

	mu      sync.Mutex
	prompts int
}

func newStubAgent() *stubAgent {
	return &stubAgent{
		events:  make(chan acp.Event, 64),
		replies: make(chan acp.PromptResult, 16),
		done:    make(chan struct{}),
	}
}

func (a *stubAgent) Events() <-chan acp.Event { return a.events }

func (a *stubAgent) Prompt(context.Context, string, []acp.ContentBlock) (acp.PromptResult, error) {
	a.mu.Lock()
	a.prompts++
	a.mu.Unlock()
	select {
	case result := <-a.replies:
		return result, nil
	case <-a.done:
		return acp.PromptResult{}, acp.ErrClosed
	}
}

func (a *stubAgent) Cancel(string) error { return nil }
func (a *stubAgent) SetMode(context.Context, string, string) error {
	return nil
}
func (a *stubAgent) SetConfigOption(context.Context, string, string, string) error {
	return nil
}
func (a *stubAgent) AnswerPermission(string, string) error { return nil }

func (a *stubAgent) promptCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.prompts
}

func (a *stubAgent) stop() {
	a.once.Do(func() {
		a.events <- acp.Event{Kind: acp.EventExit, Exit: &acp.Exit{Err: io.EOF}}
		close(a.events)
		close(a.done)
	})
}

// view is one test client of the endpoint.
type view struct {
	t     *testing.T
	conn  net.Conn
	lines *bufio.Scanner
}

func dialView(t *testing.T, path string) *view {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64<<10), protocol.MaxLineBytes)
	return &view{t: t, conn: conn, lines: scanner}
}

func (v *view) send(message protocol.ClientMessage) {
	v.t.Helper()
	data, err := json.Marshal(message)
	if err != nil {
		v.t.Fatalf("encode frame: %v", err)
	}
	_ = v.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, err := v.conn.Write(append(data, '\n')); err != nil {
		v.t.Fatalf("write frame: %v", err)
	}
}

func (v *view) hello(cursor *protocol.Cursor) {
	v.t.Helper()
	v.send(protocol.ClientMessage{V: protocol.Version, Type: protocol.TypeHello, Client: "test", Cursor: cursor})
}

func (v *view) command(id string, command protocol.Command) {
	v.t.Helper()
	v.send(protocol.ClientMessage{V: protocol.Version, Type: protocol.TypeCommand, ID: id, Command: &command})
}

func (v *view) read() protocol.ServerMessage {
	v.t.Helper()
	_ = v.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if !v.lines.Scan() {
		v.t.Fatalf("read frame: %v", v.lines.Err())
	}
	line := v.lines.Bytes()
	var message protocol.ServerMessage
	if err := json.Unmarshal(line, &message); err != nil {
		v.t.Fatalf("decode frame %s: %v", line, err)
	}
	if err := message.Validate(); err != nil {
		v.t.Fatalf("server sent an invalid frame %s: %v", line, err)
	}
	return message
}

func (v *view) expectClosed() {
	v.t.Helper()
	_ = v.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var scratch [1]byte
	if _, err := v.conn.Read(scratch[:]); err == nil {
		v.t.Fatal("connection is still open")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		v.t.Fatal("connection was not closed")
	}
}

// greet performs the handshake and returns the welcome and its follow-up.
func (v *view) greet(cursor *protocol.Cursor) (protocol.ServerMessage, protocol.ServerMessage) {
	v.t.Helper()
	v.hello(cursor)
	welcome := v.read()
	if welcome.Type != protocol.TypeWelcome {
		v.t.Fatalf("first reply = %q, want welcome", welcome.Type)
	}
	second := v.read()
	if second.Type != protocol.TypeSnapshot && second.Type != protocol.TypeChanges {
		v.t.Fatalf("second reply = %q, want snapshot or changes", second.Type)
	}
	return welcome, second
}

// readResult returns the result for id, skipping change frames the pump may
// deliver first.
func (v *view) readResult(id string) protocol.ServerMessage {
	v.t.Helper()
	for i := 0; i < 64; i++ {
		frame := v.read()
		if frame.Type == protocol.TypeChanges {
			continue
		}
		if frame.Type != protocol.TypeResult || frame.ID != id {
			v.t.Fatalf("frame = %+v, want result %q", frame, id)
		}
		return frame
	}
	v.t.Fatalf("no result %q after 64 frames", id)
	return protocol.ServerMessage{}
}

type testRig struct {
	server *Server
	hub    *hub.Hub
	agent  *stubAgent
	path   string
}

func startRig(t *testing.T, historyChanges int) *testRig {
	t.Helper()
	agent := newStubAgent()
	transcript := hub.New(hub.Config{
		ID:             "0123456789abcdef",
		Agent:          "claude",
		Title:          "claude · pairfob",
		HistoryChanges: historyChanges,
	})
	transcript.SetAgent(agent)
	if err := transcript.Ready(acp.Session{
		SessionID: "sess-1",
		Modes: &acp.SessionModes{
			CurrentModeID:  "default",
			AvailableModes: []acp.Mode{{ID: "default", Name: "Default"}},
		},
	}); err != nil {
		t.Fatalf("ready: %v", err)
	}
	go transcript.Run()

	dir, err := os.MkdirTemp("", "pfc-")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "chat.sock")
	server, err := Listen(Options{Path: path, Hub: transcript})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = server.Serve() }()
	t.Cleanup(func() {
		_ = server.Close()
		agent.stop()
	})
	return &testRig{server: server, hub: transcript, agent: agent, path: path}
}

func TestHelloReturnsWelcomeAndSnapshot(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	welcome, second := v.greet(nil)

	if welcome.Seq != rig.hub.Cursor().Seq {
		t.Fatalf("welcome seq = %d, hub seq = %d", welcome.Seq, rig.hub.Cursor().Seq)
	}
	if len(welcome.Epoch) != 8 {
		t.Fatalf("epoch = %q, want 8 hex characters", welcome.Epoch)
	}
	if second.Type != protocol.TypeSnapshot {
		t.Fatalf("follow-up = %q", second.Type)
	}
	if second.State == nil || second.State.ID != "0123456789abcdef" || second.State.Status != protocol.StatusIdle {
		t.Fatalf("snapshot state = %+v", second.State)
	}

	v.send(protocol.ClientMessage{V: protocol.Version, Type: protocol.TypePing})
	if pong := v.read(); pong.Type != protocol.TypePong {
		t.Fatalf("ping reply = %q", pong.Type)
	}
}

func TestCursorReplayAndLiveChanges(t *testing.T) {
	rig := startRig(t, 0)
	if err := rig.hub.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	if err := rig.hub.SetAutoAccept(false); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	head := rig.hub.Cursor()

	v := dialView(t, rig.path)
	welcome, replay := v.greet(&protocol.Cursor{Epoch: head.Epoch, Seq: head.Seq - 1})
	if welcome.Seq != head.Seq {
		t.Fatalf("welcome seq = %d, want %d", welcome.Seq, head.Seq)
	}
	if replay.Type != protocol.TypeChanges {
		t.Fatalf("follow-up = %q, want changes", replay.Type)
	}
	if len(replay.Changes) != 1 || replay.Changes[0].Seq != head.Seq {
		t.Fatalf("changes = %+v", replay.Changes)
	}

	if err := rig.hub.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	live := v.read()
	if live.Type != protocol.TypeChanges || live.Seq != head.Seq+1 {
		t.Fatalf("live frame = %+v", live)
	}
	if len(live.Changes) != 1 || live.Changes[0].Ops[0].Op != protocol.OpSetAutoAccept {
		t.Fatalf("live change = %+v", live.Changes)
	}
}

func TestCursorGapFallsBackToSnapshot(t *testing.T) {
	rig := startRig(t, 2)
	if err := rig.hub.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	if err := rig.hub.SetAutoAccept(false); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	head := rig.hub.Cursor()

	v := dialView(t, rig.path)
	_, second := v.greet(&protocol.Cursor{Epoch: head.Epoch, Seq: 0})
	if second.Type != protocol.TypeSnapshot {
		t.Fatalf("stale cursor follow-up = %q, want snapshot", second.Type)
	}

	other := dialView(t, rig.path)
	_, second = other.greet(&protocol.Cursor{Epoch: "deadbeef", Seq: head.Seq})
	if second.Type != protocol.TypeSnapshot {
		t.Fatalf("wrong epoch follow-up = %q, want snapshot", second.Type)
	}
}

func TestCommandDedupeReturnsFirstResult(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	enabled := true
	v.command("c1", protocol.Command{Kind: protocol.CommandSetAutoAccept, Enabled: &enabled})
	if result := v.readResult("c1"); result.OK == nil || !*result.OK {
		t.Fatalf("first result = %+v", result)
	}
	if !rig.hub.Snapshot().AutoAccept {
		t.Fatal("command did not apply")
	}

	disabled := false
	v.command("c2", protocol.Command{Kind: protocol.CommandSetAutoAccept, Enabled: &disabled})
	if result := v.readResult("c2"); result.OK == nil || !*result.OK {
		t.Fatalf("second result = %+v", result)
	}
	if rig.hub.Snapshot().AutoAccept {
		t.Fatal("second command did not apply")
	}

	v.command("c1", protocol.Command{Kind: protocol.CommandSetAutoAccept, Enabled: &enabled})
	if result := v.readResult("c1"); result.OK == nil || !*result.OK {
		t.Fatalf("replayed result = %+v", result)
	}
	if rig.hub.Snapshot().AutoAccept {
		t.Fatal("a repeated command id ran again")
	}
}

func TestPromptCommandQueuesAndReportsOK(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	v.command("c1", protocol.Command{Kind: protocol.CommandPrompt, Text: "first"})
	if result := v.readResult("c1"); result.OK == nil || !*result.OK {
		t.Fatalf("first prompt result = %+v", result)
	}
	deadline := time.Now().Add(3 * time.Second)
	for rig.agent.promptCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if rig.agent.promptCount() != 1 {
		t.Fatalf("prompts = %d", rig.agent.promptCount())
	}

	v.command("c2", protocol.Command{Kind: protocol.CommandPrompt, Text: "second"})
	if result := v.readResult("c2"); result.OK == nil || !*result.OK {
		t.Fatalf("queued prompt result = %+v", result)
	}
	if queue := rig.hub.Snapshot().Queue; len(queue) != 1 || queue[0].Text != "second" {
		t.Fatalf("queue = %+v", queue)
	}
}

func TestCommandErrorsUseContractCodes(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	v.command("c1", protocol.Command{Kind: protocol.CommandSetMode, ModeID: "nope"})
	result := v.readResult("c1")
	if result.OK == nil || *result.OK || result.Error == nil || result.Error.Code != protocol.ErrCodeNotFound {
		t.Fatalf("set_mode result = %+v", result)
	}

	v.command("c2", protocol.Command{Kind: protocol.CommandPrompt, Text: ""})
	result = v.readResult("c2")
	if result.OK == nil || *result.OK || result.Error == nil || result.Error.Code != protocol.ErrCodeInvalid {
		t.Fatalf("empty prompt result = %+v", result)
	}
}

func TestOversizedLineClosesConnection(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	payload := bytes.Repeat([]byte("a"), protocol.MaxLineBytes+1)
	payload = append(payload, '\n')
	go func() {
		_ = v.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		_, _ = v.conn.Write(payload)
	}()
	v.expectClosed()
}

func TestMalformedHelloClosesConnection(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	_ = v.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, err := v.conn.Write([]byte("not json\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	frame := v.read()
	if frame.Type != protocol.TypeResult || frame.ID != "hello" || frame.OK == nil || *frame.OK {
		t.Fatalf("frame = %+v", frame)
	}
	v.expectClosed()
}

func TestViewLimitClosesNinthConnection(t *testing.T) {
	rig := startRig(t, 0)
	for i := 0; i < defaultMaxViews; i++ {
		v := dialView(t, rig.path)
		v.greet(nil)
	}

	extra := dialView(t, rig.path)
	frame := extra.read()
	if frame.Type != protocol.TypeResult || frame.OK == nil || *frame.OK {
		t.Fatalf("ninth view frame = %+v", frame)
	}
	if frame.Error == nil || frame.Error.Code != protocol.ErrCodeBusy {
		t.Fatalf("ninth view error = %+v", frame.Error)
	}
	extra.expectClosed()
}

func TestSocketAndDirectoryModes(t *testing.T) {
	rig := startRig(t, 0)
	socketInfo, err := os.Stat(rig.path)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if mode := socketInfo.Mode().Perm(); mode != 0o600 {
		t.Fatalf("socket mode = %o, want 600", mode)
	}
	dirInfo, err := os.Stat(filepath.Dir(rig.path))
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if mode := dirInfo.Mode().Perm(); mode != 0o700 {
		t.Fatalf("directory mode = %o, want 700", mode)
	}
}

func TestListenRefusesToReplaceARegularFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chat.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	transcript := hub.New(hub.Config{ID: "0123456789abcdef", Agent: "claude", Title: "t"})
	if _, err := Listen(Options{Path: path, Hub: transcript}); err == nil {
		t.Fatal("listen replaced a regular file")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "not a socket" {
		t.Fatalf("file was changed: %q, %v", data, err)
	}
}

func TestReplayAppliesToTheSameState(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	_, second := v.greet(nil)
	if second.Type != protocol.TypeSnapshot {
		t.Fatalf("follow-up = %q", second.Type)
	}
	before := second.State.Clone()

	if err := rig.hub.SetAutoAccept(true); err != nil {
		t.Fatalf("auto accept: %v", err)
	}
	frame := v.read()
	if frame.Type != protocol.TypeChanges {
		t.Fatalf("frame = %+v", frame)
	}
	for _, change := range frame.Changes {
		if err := before.Apply(change.Ops); err != nil {
			t.Fatalf("apply change %d: %v", change.Seq, err)
		}
	}
	if before.AutoAccept != rig.hub.Snapshot().AutoAccept {
		t.Fatal("replayed state diverged from the hub")
	}
}

func TestDedupeExpiresAfterTheWindow(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	enabled := true
	v.command("c1", protocol.Command{Kind: protocol.CommandSetAutoAccept, Enabled: &enabled})
	if result := v.readResult("c1"); result.OK == nil || !*result.OK {
		t.Fatalf("first result = %+v", result)
	}

	c := findConn(rig.server)
	if c == nil {
		t.Fatal("no live connection")
	}
	c.dedupe["c1"] = cachedResult{at: time.Now().Add(-dedupeWindow - time.Minute)}

	disabled := false
	v.command("c1", protocol.Command{Kind: protocol.CommandSetAutoAccept, Enabled: &disabled})
	if result := v.readResult("c1"); result.OK == nil || !*result.OK {
		t.Fatalf("expired replay result = %+v", result)
	}
	if rig.hub.Snapshot().AutoAccept {
		t.Fatal("an expired command id was not re-run")
	}
}

func findConn(server *Server) *conn {
	server.mu.Lock()
	defer server.mu.Unlock()
	for c := range server.conns {
		return c
	}
	return nil
}

func TestDuplicateHelloClosesConnection(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)

	v.hello(nil)
	frame := v.read()
	if frame.Type != protocol.TypeResult || frame.ID != "hello" || frame.OK == nil || *frame.OK {
		t.Fatalf("second hello frame = %+v", frame)
	}
	v.expectClosed()
}

func TestSocketPathAndDefaultDir(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/tmp/state")
	dir, err := DefaultDir()
	if err != nil {
		t.Fatalf("default dir: %v", err)
	}
	if dir != "/tmp/state/pairfob/chat" {
		t.Fatalf("dir = %q", dir)
	}
	if path := SocketPath(dir, "0123456789abcdef"); path != "/tmp/state/pairfob/chat/0123456789abcdef.sock" {
		t.Fatalf("path = %q", path)
	}

	t.Setenv("XDG_STATE_HOME", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("home: %v", err)
	}
	dir, err = DefaultDir()
	if err != nil {
		t.Fatalf("default dir: %v", err)
	}
	if want := filepath.Join(home, ".local", "state", "pairfob", "chat"); dir != want {
		t.Fatalf("dir = %q, want %q", dir, want)
	}
}

func TestCloseRemovesSocket(t *testing.T) {
	rig := startRig(t, 0)
	path := rig.path
	if err := rig.server.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket still exists: %v", err)
	}
}

func TestViewSeesHubClose(t *testing.T) {
	rig := startRig(t, 0)
	v := dialView(t, rig.path)
	v.greet(nil)
	rig.agent.stop()
	deadline := time.Now().Add(3 * time.Second)
	for rig.hub.Snapshot().Status != protocol.StatusExited && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	frame := v.read()
	if frame.Type != protocol.TypeChanges {
		t.Fatalf("frame = %+v", frame)
	}
	state := rig.hub.Snapshot()
	if state.Status != protocol.StatusExited {
		t.Fatalf("status = %q", state.Status)
	}
}
