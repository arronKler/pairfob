package runtime

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type coreScriptRequest struct {
	id     uint64
	method string
	params json.RawMessage
}

type coreScriptPush struct {
	channel uint32
	kind    byte
	data    []byte
}

type coreScriptReply struct {
	result     any
	err        *coreRPCError
	mismatchID bool
	close      bool
	push       []coreScriptPush
	// closeChannels are written as CLOSE frames after the reply's pushes.
	closeChannels []uint32
}

type coreScriptFrame struct {
	channel uint32
	kind    byte
	payload []byte
}

type coreScriptLog struct {
	mu       sync.Mutex
	hello    []byte
	requests []coreScriptRequest
	frames   []coreScriptFrame
}

func (l *coreScriptLog) appendHello(line []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.hello = append([]byte(nil), line...)
}

func (l *coreScriptLog) appendRequest(request coreScriptRequest) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = append(l.requests, request)
}

func (l *coreScriptLog) appendFrame(frame coreScriptFrame) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.frames = append(l.frames, frame)
}

func (l *coreScriptLog) helloRequest() (string, json.RawMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var request struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	_ = json.Unmarshal(l.hello, &request)
	return request.Method, request.Params
}

func (l *coreScriptLog) requestFor(method string) (coreScriptRequest, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, request := range l.requests {
		if request.method == method {
			return request, true
		}
	}
	return coreScriptRequest{}, false
}

func (l *coreScriptLog) framesOf(channel uint32) []coreScriptFrame {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]coreScriptFrame, 0, len(l.frames))
	for _, frame := range l.frames {
		if frame.channel == channel {
			out = append(out, frame)
		}
	}
	return out
}

func (l *coreScriptLog) hasFrame(channel uint32, kind byte) bool {
	for _, frame := range l.framesOf(channel) {
		if frame.kind == kind {
			return true
		}
	}
	return false
}

func coreScriptHello() map[string]any {
	return map[string]any{
		"generation": 3, "version": "0.1.14",
		"core":    map[string]any{"id": "core-1", "name": "test-core"},
		"framed":  true,
		"methods": []string{"hello", "server.status", "terminal.list", "terminal.read", "terminal.get", "terminal.attach", "terminal.send", "terminal.keys", "terminal.label", "terminal.kill", "terminal.rm", "terminal.run", "templates.list"},
	}
}

func startCoreScript(t *testing.T, helloResult any, handler func(coreScriptRequest) coreScriptReply) (*coreConn, *coreScriptLog, error) {
	t.Helper()
	client, server := net.Pipe()
	conn := newCoreConn(client, func() { _ = client.Close() }, nil)
	log := &coreScriptLog{}
	t.Cleanup(func() {
		_ = conn.Close()
		_ = server.Close()
	})
	go serveCoreScript(server, log, helloResult, handler)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := conn.start(ctx)
	return conn, log, err
}

func serveCoreScript(conn net.Conn, log *coreScriptLog, helloResult any, handler func(coreScriptRequest) coreScriptReply) {
	defer conn.Close()
	// A separate writer keeps this script reading while it pushes several
	// frames: net.Pipe writes are synchronous, so one goroutine writing every
	// reply and push would deadlock against a client that credits as it reads.
	writes := make(chan coreScriptFrame, 256)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for frame := range writes {
			if writeCoreScriptFrame(conn, frame.channel, frame.kind, frame.payload) != nil {
				return
			}
		}
	}()
	enqueue := func(channel uint32, kind byte, payload []byte) bool {
		select {
		case writes <- coreScriptFrame{channel: channel, kind: kind, payload: payload}:
			return true
		case <-writerDone:
			return false
		}
	}
	defer func() {
		close(writes)
		_ = conn.Close() // unblocks a writer still waiting on a peer that stopped reading
		<-writerDone
	}()
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return
	}
	log.appendHello(line)
	reply, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 0, "result": helloResult})
	if err != nil {
		return
	}
	if _, err := conn.Write(append(reply, '\n')); err != nil {
		return
	}
	for {
		header := make([]byte, coreFrameHeader)
		if _, err := io.ReadFull(reader, header); err != nil {
			return
		}
		channel := binary.LittleEndian.Uint32(header[0:4])
		kind := header[4]
		length := binary.LittleEndian.Uint32(header[5:9])
		payload := make([]byte, length)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return
		}
		log.appendFrame(coreScriptFrame{channel: channel, kind: kind, payload: append([]byte(nil), payload...)})
		if kind != coreKindData || channel != coreRPCChannel {
			continue
		}
		var request struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(payload, &request) != nil {
			return
		}
		parsed := coreScriptRequest{id: request.ID, method: request.Method, params: request.Params}
		log.appendRequest(parsed)
		result := handler(parsed)
		if result.close {
			return
		}
		responseID := request.ID
		if result.mismatchID {
			responseID++
		}
		var envelope map[string]any
		if result.err != nil {
			data := map[string]any{}
			if result.err.Kind != "" {
				data["kind"] = result.err.Kind
			}
			envelope = map[string]any{
				"id": responseID,
				"error": map[string]any{
					"code": result.err.Code, "message": result.err.Message, "data": data,
				},
			}
		} else {
			envelope = map[string]any{"id": responseID, "result": result.result}
		}
		encoded, err := json.Marshal(envelope)
		if err != nil {
			return
		}
		if !enqueue(coreRPCChannel, coreKindData, encoded) {
			return
		}
		for _, push := range result.push {
			if !enqueue(push.channel, push.kind, push.data) {
				return
			}
		}
		for _, channel := range result.closeChannels {
			if !enqueue(channel, coreKindClose, nil) {
				return
			}
		}
	}
}

func writeCoreScriptFrame(writer io.Writer, channel uint32, kind byte, payload []byte) error {
	frame := make([]byte, coreFrameHeader+len(payload))
	binary.LittleEndian.PutUint32(frame[0:4], channel)
	frame[4] = kind
	binary.LittleEndian.PutUint32(frame[5:9], uint32(len(payload)))
	copy(frame[coreFrameHeader:], payload)
	_, err := writer.Write(frame)
	return err
}

func TestCoreConnHandshakeAndCall(t *testing.T) {
	conn, log, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
		if request.method == "terminal.list" {
			return coreScriptReply{result: map[string]any{
				"terminals": []any{map[string]any{"address": "t3", "state": "live", "cols": 80, "rows": 24}},
				"machines":  []any{}, "hidden_finished": 0,
			}}
		}
		return coreScriptReply{result: map[string]any{}}
	})
	if err != nil {
		t.Fatal(err)
	}
	hello := conn.Hello()
	if hello.Generation != 3 || hello.Version != "0.1.14" || hello.CoreID != "core-1" || !hello.Framed || !hello.has("terminal.list") {
		t.Fatalf("hello=%+v", hello)
	}
	method, params := log.helloRequest()
	var handshake struct {
		Framed bool `json:"framed"`
	}
	_ = json.Unmarshal(params, &handshake)
	if method != "hello" || !handshake.Framed {
		t.Fatalf("handshake method=%q params=%s", method, params)
	}
	var list coreListResult
	if err := conn.Call(context.Background(), "terminal.list", map[string]any{"all": false}, &list); err != nil {
		t.Fatal(err)
	}
	if list.Terminals == nil || len(*list.Terminals) != 1 || (*list.Terminals)[0].Address != "t3" {
		t.Fatalf("list=%+v", list)
	}
	request, ok := log.requestFor("terminal.list")
	if !ok || string(request.params) != `{"all":false}` {
		t.Fatalf("request=%+v", request)
	}
}

func TestCoreConnRejectsNonFramedHandshake(t *testing.T) {
	hello := coreScriptHello()
	hello["framed"] = false
	if _, _, err := startCoreScript(t, hello, func(coreScriptRequest) coreScriptReply {
		return coreScriptReply{result: map[string]any{}}
	}); err == nil {
		t.Fatal("plain-mode handshake was accepted")
	}
}

func TestCoreConnResponseIDMismatch(t *testing.T) {
	conn, _, err := startCoreScript(t, coreScriptHello(), func(coreScriptRequest) coreScriptReply {
		return coreScriptReply{mismatchID: true, result: map[string]any{"version": "0.1.14"}}
	})
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	err = conn.Call(context.Background(), "server.status", nil, &status)
	var protocolErr *coreProtocolError
	if !errors.As(err, &protocolErr) {
		t.Fatalf("mismatched id returned %v", err)
	}
	if err := conn.Call(context.Background(), "server.status", nil, &status); err == nil {
		t.Fatal("a desynchronized connection kept serving calls")
	}
}

func TestCoreConnAttachTypeCloseAndCredit(t *testing.T) {
	conn, log, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
		if request.method == "terminal.attach" {
			return coreScriptReply{
				result: map[string]any{"channel": 7, "terminal": map[string]any{"address": "t3", "state": "live", "cols": 80, "rows": 24}},
				push:   []coreScriptPush{{channel: 7, data: []byte("paint")}},
			}
		}
		return coreScriptReply{result: map[string]any{}}
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	channel, err := conn.OpenInput(ctx, "t3", 80, 24)
	if err != nil || channel != 7 {
		t.Fatalf("channel=%d err=%v", channel, err)
	}
	request, ok := log.requestFor("terminal.attach")
	if !ok {
		t.Fatal("attach was not sent")
	}
	var attach struct {
		Terminal string `json:"terminal"`
		Observe  bool   `json:"observe"`
		History  int    `json:"history"`
		Cols     int    `json:"cols"`
		Rows     int    `json:"rows"`
	}
	_ = json.Unmarshal(request.params, &attach)
	if attach.Terminal != "t3" || attach.Observe || attach.History != 0 || attach.Cols != 80 || attach.Rows != 24 {
		t.Fatalf("attach params=%s", request.params)
	}
	waitForCore(t, func() bool { return log.hasFrame(7, coreKindCredit) })
	credit := log.framesOf(7)
	found := false
	for _, frame := range credit {
		if frame.kind == coreKindCredit && len(frame.payload) == 4 && binary.LittleEndian.Uint32(frame.payload) == uint32(len("paint")) {
			found = true
		}
	}
	if !found {
		t.Fatalf("discarded paint was not credited: %+v", credit)
	}
	if err := conn.TypeInput(7, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := conn.ResizeInput(7, 132, 43); err != nil {
		t.Fatal(err)
	}
	waitForCore(t, func() bool { return log.hasFrame(7, coreKindResize) })
	var resized bool
	for _, frame := range log.framesOf(7) {
		if frame.kind != coreKindResize {
			continue
		}
		if len(frame.payload) != 4 || binary.LittleEndian.Uint16(frame.payload[0:2]) != 132 ||
			binary.LittleEndian.Uint16(frame.payload[2:4]) != 43 {
			t.Fatalf("resize frame=%+v", frame)
		}
		resized = true
	}
	if !resized {
		t.Fatalf("resize frame missing: %+v", log.framesOf(7))
	}
	var sizeErr *coreProtocolError
	if err := conn.ResizeInput(7, 0, 24); !errors.As(err, &sizeErr) {
		t.Fatalf("zero-size resize returned %v", err)
	}
	if err := conn.CloseInput(7); err != nil {
		t.Fatal(err)
	}
	waitForCore(t, func() bool { return log.hasFrame(7, coreKindClose) })
	var streamErr *coreStreamClosedError
	if err := conn.ResizeInput(7, 100, 40); !errors.As(err, &streamErr) {
		t.Fatalf("resize after close returned %v", err)
	}
	var typed, closed bool
	for _, frame := range log.framesOf(7) {
		if frame.kind == coreKindData && string(frame.payload) == "abc" {
			typed = true
		}
		if frame.kind == coreKindClose {
			closed = true
		}
	}
	if !typed || !closed {
		t.Fatalf("typed=%v closed=%v frames=%+v", typed, closed, log.framesOf(7))
	}
}

func TestCoreConnServerCloseIsOffline(t *testing.T) {
	conn, _, err := startCoreScript(t, coreScriptHello(), func(coreScriptRequest) coreScriptReply {
		return coreScriptReply{close: true}
	})
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	err = conn.Call(context.Background(), "server.status", nil, &status)
	var transportErr *coreTransportError
	if !errors.As(err, &transportErr) {
		t.Fatalf("closed connection returned %v", err)
	}
	fault, ok := AsFault(coreFault("snapshot", err, false, false))
	if !ok || fault.Code != CodeOffline {
		t.Fatalf("fault=%+v", fault)
	}
}

func TestCoreConnReconnectsAfterLoss(t *testing.T) {
	first, _, err := startCoreScript(t, coreScriptHello(), func(coreScriptRequest) coreScriptReply {
		return coreScriptReply{close: true}
	})
	if err != nil {
		t.Fatal(err)
	}
	second := newFakeCoreTransport()
	dials := 0
	core := NewCore("test-hc")
	core.dial = func(context.Context) (coreTransport, coreHello, error) {
		dials++
		if dials == 1 {
			return first, first.Hello(), nil
		}
		return second, second.Hello(), nil
	}
	core.inputIdle = time.Hour
	t.Cleanup(func() { _ = core.Close() })
	ctx := context.Background()
	if _, err := core.Describe(ctx, DefaultSession()); err == nil {
		t.Fatal("a lost connection produced a descriptor")
	}
	if _, err := core.Describe(ctx, DefaultSession()); err != nil {
		t.Fatal(err)
	}
	if dials != 2 {
		t.Fatalf("dial count=%d", dials)
	}
}

func TestCoreConnOpenOutputKeepsEarlyFrames(t *testing.T) {
	conn, log, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
		if request.method != "terminal.attach" {
			return coreScriptReply{result: map[string]any{}}
		}
		resize := make([]byte, 4)
		binary.LittleEndian.PutUint16(resize[0:2], 120)
		binary.LittleEndian.PutUint16(resize[2:4], 50)
		return coreScriptReply{
			result: map[string]any{"channel": 7, "terminal": map[string]any{"address": "t3", "state": "live", "cols": 80, "rows": 24}},
			push: []coreScriptPush{
				{channel: 7, kind: coreKindResize, data: resize},
				{channel: 7, data: []byte("paint")},
			},
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	channel, items, err := conn.OpenOutput(context.Background(), "t3", 80, 24)
	if err != nil || channel != 7 {
		t.Fatalf("channel=%d err=%v", channel, err)
	}
	first := <-items
	if first.kind != coreKindResize || first.cols != 120 || first.rows != 50 {
		t.Fatalf("first=%+v", first)
	}
	second := <-items
	if second.kind != coreKindData || string(second.payload) != "paint" {
		t.Fatalf("second=%+v", second)
	}
	waitForCore(t, func() bool { return log.hasFrame(7, coreKindCredit) })
	if err := conn.CloseInput(7); err != nil {
		t.Fatal(err)
	}
}

func TestCoreConnOpenEventsDeliversLines(t *testing.T) {
	conn, _, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
		switch request.method {
		case "events.subscribe":
			return coreScriptReply{
				result: map[string]any{"channel": 9, "seq": 0, "terminals": []any{}},
				push: []coreScriptPush{
					{channel: 9, data: []byte(`{"method":"event","params":{"type":"created","terminal":"t1"}}` + "\n")},
					{channel: 9, data: []byte(`{"method":"event","params":{"type":"status","terminal":"t1","data":{"status":{"state":"idle"}}}}` + "\n")},
				},
			}
		case "terminal.get":
			return coreScriptReply{
				result:        map[string]any{"address": "t3", "state": "live", "cols": 80, "rows": 24},
				closeChannels: []uint32{9},
			}
		}
		return coreScriptReply{result: map[string]any{}}
	})
	if err != nil {
		t.Fatal(err)
	}
	channel, items, err := conn.OpenEvents(context.Background())
	if err != nil || channel != 9 {
		t.Fatalf("channel=%d err=%v", channel, err)
	}
	first := <-items
	second := <-items
	if first.kind != coreKindData || !strings.Contains(string(first.payload), `"created"`) {
		t.Fatalf("first=%+v", first)
	}
	if second.kind != coreKindData || !strings.Contains(string(second.payload), `"idle"`) {
		t.Fatalf("second=%+v", second)
	}
	var terminal coreTerminal
	if err := conn.Call(context.Background(), "terminal.get", map[string]any{"terminal": "t3"}, &terminal); err != nil {
		t.Fatal(err)
	}
	select {
	case _, ok := <-items:
		if ok {
			t.Fatal("event channel stayed open after CLOSE")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("event channel did not close")
	}
}

func TestCoreConnStreamOverflowClosesSink(t *testing.T) {
	conn, _, err := startCoreScript(t, coreScriptHello(), func(request coreScriptRequest) coreScriptReply {
		if request.method != "terminal.attach" {
			return coreScriptReply{result: map[string]any{}}
		}
		push := make([]coreScriptPush, 0, coreStreamBuffer+8)
		for index := 0; index < coreStreamBuffer+8; index++ {
			push = append(push, coreScriptPush{channel: 7, data: []byte{byte('a' + index%26)}})
		}
		return coreScriptReply{
			result: map[string]any{"channel": 7, "terminal": map[string]any{"address": "t3", "state": "live", "cols": 80, "rows": 24}},
			push:   push,
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	_, items, err := conn.OpenOutput(context.Background(), "t3", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	// Stall the consumer so the bounded sink overflows and closes itself.
	time.Sleep(50 * time.Millisecond)
	count := 0
	for range items {
		count++
	}
	if count != coreStreamBuffer {
		t.Fatalf("delivered %d frames before overflow, want %d", count, coreStreamBuffer)
	}
}

func TestCoreOpenConfigured(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "herdr.sock")
	t.Setenv("HERDR_SOCKET_PATH", socket)
	t.Setenv("PAIRFOB_HC", "")

	t.Setenv("PAIRFOB_RUNTIME", "")
	rt, source, err := OpenConfigured(false, false)
	if err != nil || source != "herdr:"+socket {
		t.Fatalf("runtime=%T source=%q err=%v", rt, source, err)
	}
	if _, ok := rt.(*Herdr); !ok {
		t.Fatalf("default runtime=%T", rt)
	}

	t.Setenv("PAIRFOB_RUNTIME", "core")
	rt, source, err = OpenConfigured(false, false)
	if err != nil || source != "herdr-core:hc" {
		t.Fatalf("runtime=%T source=%q err=%v", rt, source, err)
	}
	if _, ok := rt.(*Core); !ok {
		t.Fatalf("core runtime=%T", rt)
	}

	t.Setenv("PAIRFOB_RUNTIME", "HERDR-CORE")
	t.Setenv("PAIRFOB_HC", " /opt/hc ")
	rt, source, err = OpenConfigured(false, false)
	if err != nil || source != "herdr-core:/opt/hc" {
		t.Fatalf("runtime=%T source=%q err=%v", rt, source, err)
	}
	if core, ok := rt.(*Core); !ok || core.command != "/opt/hc" {
		t.Fatalf("core runtime=%T", rt)
	}

	t.Setenv("PAIRFOB_RUNTIME", "bogus")
	rt, _, err = OpenConfigured(false, false)
	fault, ok := AsFault(err)
	if rt != nil || !ok || fault.Code != CodeInvalid {
		t.Fatalf("runtime=%T fault=%+v err=%v", rt, fault, err)
	}

	t.Setenv("PAIRFOB_RUNTIME", "core")
	rt, source, err = OpenConfigured(true, false)
	if err != nil || source != "fake:explicit-dev" {
		t.Fatalf("runtime=%T source=%q err=%v", rt, source, err)
	}
	if _, ok := rt.(*Fake); !ok {
		t.Fatalf("dev fake runtime=%T", rt)
	}
}

func TestCoreDefaultHC(t *testing.T) {
	t.Setenv("PAIRFOB_HC", "")
	if command := DefaultHC(); command != "hc" {
		t.Fatalf("DefaultHC()=%q", command)
	}
	t.Setenv("PAIRFOB_HC", " /usr/local/bin/hc ")
	if command := DefaultHC(); command != "/usr/local/bin/hc" {
		t.Fatalf("DefaultHC()=%q", command)
	}
}
