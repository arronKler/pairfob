package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

type coreFakeCall struct {
	method string
	params json.RawMessage
}

type coreFakeTyped struct {
	channel uint32
	data    []byte
}

type coreFakeAttach struct {
	terminal string
	cols     int
	rows     int
}

type coreFakeResize struct {
	channel uint32
	cols    int
	rows    int
}

// fakeCoreTransport is a scripted in-memory herdr-core connection. Unit tests
// never spawn hc or touch a real core.
type fakeCoreTransport struct {
	mu sync.Mutex

	hello   coreHello
	handler func(string, json.RawMessage) (any, error)
	attach  func(string, int, int) (uint32, error)

	calls        []coreFakeCall
	typed        []coreFakeTyped
	attaches     []coreFakeAttach
	resizes      []coreFakeResize
	closedInputs []uint32
	closeCalls   int
	typeErr      error
	nextChannel  uint32
	closed       bool

	eventCalls   int
	eventChannel uint32
	eventItems   chan coreStreamItem
	outputs      map[uint32]chan coreStreamItem
}

func newFakeCoreTransport() *fakeCoreTransport {
	return &fakeCoreTransport{
		hello: coreHello{
			Generation: 2, Version: "0.1.14", CoreID: "core-1", CoreName: "test-core",
			Framed: true, Methods: coreTestMethods(),
		},
		nextChannel: 3,
	}
}

func coreTestMethods() map[string]bool {
	names := []string{
		"hello", "server.status", "terminal.list", "terminal.read", "terminal.get",
		"terminal.attach", "terminal.send", "terminal.keys", "terminal.label",
		"terminal.kill", "terminal.rm", "terminal.run", "templates.list",
		"events.subscribe",
	}
	methods := make(map[string]bool, len(names))
	for _, name := range names {
		methods[name] = true
	}
	return methods
}

func (f *fakeCoreTransport) Hello() coreHello { return f.hello }

func (f *fakeCoreTransport) Call(ctx context.Context, method string, params any, out any) error {
	if err := ctx.Err(); err != nil {
		return &coreTransportError{cause: err, timeout: true}
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.calls = append(f.calls, coreFakeCall{method: method, params: raw})
	handler := f.handler
	f.mu.Unlock()
	var result any
	if handler != nil {
		result, err = handler(method, raw)
	} else {
		result, err = coreFakeDefault(method, raw)
	}
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return json.Unmarshal(encoded, out)
}

func coreFakeDefault(method string, params json.RawMessage) (any, error) {
	terminal := func(address string) map[string]any {
		return map[string]any{
			"address": address, "state": "live", "cwd": "/tmp", "cols": 80, "rows": 24,
			"name": nil, "title": "", "labels": map[string]string{},
		}
	}
	var request struct {
		Terminal string            `json:"terminal"`
		Labels   map[string]string `json:"labels"`
	}
	_ = json.Unmarshal(params, &request)
	switch method {
	case "server.status":
		return map[string]any{"version": "0.1.14"}, nil
	case "templates.list":
		return map[string]any{"templates": []any{}}, nil
	case "terminal.list":
		return map[string]any{"terminals": []any{}, "hidden_finished": 0, "machines": []any{}}, nil
	case "terminal.get", "terminal.label", "terminal.kill":
		value := terminal(request.Terminal)
		if method == "terminal.kill" {
			value["state"] = "finished"
		}
		if request.Labels != nil {
			value["labels"] = request.Labels
		}
		return value, nil
	case "terminal.rm":
		return map[string]any{"removed": request.Terminal}, nil
	case "terminal.attach":
		return map[string]any{"channel": float64(1), "terminal": terminal(request.Terminal)}, nil
	case "terminal.read":
		return map[string]any{"text": "", "complete": true, "how": "screen"}, nil
	case "terminal.keys", "terminal.send":
		return map[string]any{"turn": 1}, nil
	case "terminal.run":
		return map[string]any{"address": "t9"}, nil
	default:
		return map[string]any{}, nil
	}
}

func (f *fakeCoreTransport) OpenInput(ctx context.Context, terminal string, cols, rows int) (uint32, error) {
	f.mu.Lock()
	f.attaches = append(f.attaches, coreFakeAttach{terminal: terminal, cols: cols, rows: rows})
	hooks := f.attach
	channel := f.nextChannel
	f.nextChannel++
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, &coreTransportError{cause: err, timeout: true}
	}
	if hooks != nil {
		return hooks(terminal, cols, rows)
	}
	return channel, nil
}

func (f *fakeCoreTransport) TypeInput(channel uint32, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.typeErr != nil {
		return f.typeErr
	}
	f.typed = append(f.typed, coreFakeTyped{channel: channel, data: append([]byte(nil), data...)})
	return nil
}

func (f *fakeCoreTransport) ResizeInput(channel uint32, cols, rows int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.typeErr != nil {
		return f.typeErr
	}
	f.resizes = append(f.resizes, coreFakeResize{channel: channel, cols: cols, rows: rows})
	return nil
}

func (f *fakeCoreTransport) CloseInput(channel uint32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closedInputs = append(f.closedInputs, channel)
	if items := f.outputs[channel]; items != nil {
		close(items)
		delete(f.outputs, channel)
	}
	return nil
}

func (f *fakeCoreTransport) closeOutput(channel uint32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if items := f.outputs[channel]; items != nil {
		close(items)
		delete(f.outputs, channel)
	}
}

func (f *fakeCoreTransport) lastOutput() (uint32, chan coreStreamItem) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for channel, items := range f.outputs {
		return channel, items
	}
	return 0, nil
}

func (f *fakeCoreTransport) OpenOutput(ctx context.Context, terminal string, cols, rows int) (uint32, <-chan coreStreamItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attaches = append(f.attaches, coreFakeAttach{terminal: terminal, cols: cols, rows: rows})
	if err := ctx.Err(); err != nil {
		return 0, nil, &coreTransportError{cause: err, timeout: true}
	}
	channel := f.nextChannel
	f.nextChannel++
	items := make(chan coreStreamItem, 32)
	if f.outputs == nil {
		f.outputs = make(map[uint32]chan coreStreamItem)
	}
	f.outputs[channel] = items
	return channel, items, nil
}

func (f *fakeCoreTransport) OpenEvents(ctx context.Context) (uint32, <-chan coreStreamItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.eventCalls++
	if err := ctx.Err(); err != nil {
		return 0, nil, &coreTransportError{cause: err, timeout: true}
	}
	if f.eventItems == nil {
		f.eventItems = make(chan coreStreamItem, 64)
	}
	if f.eventChannel == 0 {
		f.eventChannel = 100
	}
	return f.eventChannel, f.eventItems, nil
}

func (f *fakeCoreTransport) pushEvent(line string) {
	payload := []byte(line)
	if len(payload) == 0 || payload[len(payload)-1] != '\n' {
		payload = append(payload, '\n')
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.eventItems == nil {
		f.eventItems = make(chan coreStreamItem, 64)
	}
	f.eventItems <- coreStreamItem{kind: coreKindData, payload: payload}
}

func (f *fakeCoreTransport) closeEventStream() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.eventItems != nil {
		close(f.eventItems)
		f.eventItems = nil
	}
}

func (f *fakeCoreTransport) output(channel uint32) chan coreStreamItem {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.outputs[channel]
}

func (f *fakeCoreTransport) eventCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.eventCalls
}

func (f *fakeCoreTransport) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeCalls++
	if f.closed {
		return nil
	}
	f.closed = true
	if f.eventItems != nil {
		close(f.eventItems)
		f.eventItems = nil
	}
	for channel, items := range f.outputs {
		close(items)
		delete(f.outputs, channel)
	}
	return nil
}

func (f *fakeCoreTransport) callLog() []coreFakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]coreFakeCall(nil), f.calls...)
}

func (f *fakeCoreTransport) callsOf(method string) []json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]json.RawMessage, 0, len(f.calls))
	for _, call := range f.calls {
		if call.method == method {
			out = append(out, call.params)
		}
	}
	return out
}

func (f *fakeCoreTransport) typedLog() []coreFakeTyped {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]coreFakeTyped(nil), f.typed...)
}

func (f *fakeCoreTransport) attachLog() []coreFakeAttach {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]coreFakeAttach(nil), f.attaches...)
}

func (f *fakeCoreTransport) resizeLog() []coreFakeResize {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]coreFakeResize(nil), f.resizes...)
}

func (f *fakeCoreTransport) closedLog() []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]uint32(nil), f.closedInputs...)
}

func (f *fakeCoreTransport) closeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeCalls
}

func newTestCore(t *testing.T, transport coreTransport) *Core {
	t.Helper()
	core := NewCore("test-hc")
	core.dial = func(context.Context) (coreTransport, coreHello, error) {
		return transport, transport.Hello(), nil
	}
	core.inputIdle = time.Hour
	t.Cleanup(func() { _ = core.Close() })
	return core
}

func waitForCore(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition was not met before the deadline")
}

func coreTestTerminal(address, state string, status *coreStatus) coreTerminal {
	return coreTerminal{Address: address, State: state, Cwd: "/work", Cols: 80, Rows: 24, Status: status}
}

func TestCorePaneIDCodec(t *testing.T) {
	for address, paneID := range map[string]string{
		"t7":          "t7",
		"devbox/t7":   "devbox:t7",
		"named-term":  "named-term",
		"devbox/t7.2": "devbox:t7.2",
		"T7":          "T7",
	} {
		encoded, err := encodeCorePaneID(address)
		if err != nil || encoded != paneID {
			t.Fatalf("encode(%q)=%q err=%v", address, encoded, err)
		}
		decoded, err := decodeCorePaneID(paneID)
		if err != nil || decoded != address {
			t.Fatalf("decode(%q)=%q err=%v", paneID, decoded, err)
		}
	}
	for _, bad := range []string{"", "/t7", "devbox/", "dev box/t7", "devbox//t7", "devbox/t7/x", strings.Repeat("a", 65)} {
		if _, err := encodeCorePaneID(bad); err == nil {
			t.Fatalf("encoded invalid address %q", bad)
		}
	}
	for _, bad := range []string{"", ":t7", "devbox:", "devbox:t7:x", "devbox/t7", strings.Repeat("a", 65)} {
		if _, err := decodeCorePaneID(bad); err == nil {
			t.Fatalf("decoded invalid pane id %q", bad)
		}
	}
}

func TestCoreProjectionLocalAndRemote(t *testing.T) {
	name := "build"
	terminals := []coreTerminal{
		{
			Address: "t3", State: "live", Cwd: "/repo", Cols: 132, Rows: 43, Name: &name, Title: "npm test",
			Status: &coreStatus{State: "working", App: "Claude Code"}, Foreground: &coreForeground{Cwd: "/repo/app"},
			Labels: map[string]string{corePaneLabelKey: "ship it"},
		},
		{Address: "t4", State: "live", Cwd: "/repo", Cols: 80, Rows: 24, Labels: map[string]string{corePaneLabelKey: "notes"}},
		coreTestTerminal("devbox/t7", "live", &coreStatus{State: "idle", App: "codex"}),
		coreTestTerminal("devbox/t8", "finished", &coreStatus{State: "done", App: "codex"}),
		coreTestTerminal("rohan/t9", "live", &coreStatus{State: "error", App: "grok"}),
	}
	hello := newFakeCoreTransport().hello
	snapshot := projectCoreSnapshot(hello, terminals, 1700000000)

	if snapshot.HerdrVersion != "0.1.14" || snapshot.HerdrProtocol != 2 || snapshot.CapturedAt != 1700000000 {
		t.Fatalf("snapshot metadata=%+v", snapshot)
	}
	if len(snapshot.Workspaces) != 3 || len(snapshot.Tabs) != 4 || len(snapshot.Panes) != 4 || len(snapshot.Layouts) != 4 {
		t.Fatalf("workspaces=%d tabs=%d panes=%d layouts=%d", len(snapshot.Workspaces), len(snapshot.Tabs), len(snapshot.Panes), len(snapshot.Layouts))
	}
	wantWorkspaces := []Workspace{
		{WorkspaceID: "core", Number: 1, Label: "This computer", AgentStatus: "working"},
		{WorkspaceID: "machine:devbox", Number: 2, Label: "devbox", AgentStatus: "idle"},
		{WorkspaceID: "machine:rohan", Number: 3, Label: "rohan", AgentStatus: "blocked"},
	}
	for index, want := range wantWorkspaces {
		got := snapshot.Workspaces[index]
		if got.WorkspaceID != want.WorkspaceID || got.Number != want.Number || got.Label != want.Label || got.AgentStatus != want.AgentStatus || got.Cwd != "" {
			t.Fatalf("workspace %d=%+v want=%+v", index, got, want)
		}
	}
	local := snapshot.Panes[0]
	if local.PaneID != "t3" || local.WorkspaceID != "core" || local.TabID != "term:t3" || local.TerminalID != "t3" ||
		local.Agent != "claude-code" || local.DisplayAgent != "Claude Code" || local.AgentStatus != "working" ||
		local.Label == nil || *local.Label != "ship it" || local.TerminalTitle != "npm test" || local.Cwd != "/repo/app" {
		t.Fatalf("local pane=%+v", local)
	}
	if local.Scroll == nil || local.Scroll.ViewportRows != 43 {
		t.Fatalf("local scroll=%+v", local.Scroll)
	}
	if layout := snapshot.Layouts[0]; layout.Area != (LayoutRect{Width: 132, Height: 43}) ||
		len(layout.Panes) != 1 || layout.Panes[0].Rect != layout.Area {
		t.Fatalf("local layout=%+v", layout)
	}
	notes := snapshot.Panes[1]
	if notes.PaneID != "t4" || notes.Agent != "" || notes.DisplayAgent != "" || notes.AgentStatus != "" ||
		notes.Label == nil || *notes.Label != "notes" || notes.Cwd != "/repo" {
		t.Fatalf("label pane=%+v", notes)
	}
	remote := snapshot.Panes[2]
	if remote.PaneID != "devbox:t7" || remote.WorkspaceID != "machine:devbox" || remote.TabID != "term:devbox:t7" || remote.AgentStatus != "idle" {
		t.Fatalf("remote pane=%+v", remote)
	}
	if remote.Cwd != "" || remote.Tokens["cwd"] != "/work" || remote.TerminalID != "devbox/t7" {
		t.Fatalf("remote cwd leaked into the pane root: %+v", remote)
	}
	errored := snapshot.Panes[3]
	if errored.PaneID != "rohan:t9" || errored.AgentStatus != "blocked" || errored.Agent != "grok" {
		t.Fatalf("error pane=%+v", errored)
	}
	if len(snapshot.Focused) != 0 {
		t.Fatalf("focused=%v", snapshot.Focused)
	}
	for _, layout := range snapshot.Layouts {
		if len(layout.Panes) != 1 || layout.Panes[0].PaneID != layout.FocusedPaneID {
			t.Fatalf("layout=%+v", layout)
		}
	}
	if snapshot.Tabs[0].Label != "ship it" || snapshot.Tabs[1].Label != "notes" || snapshot.Tabs[2].Label != "" {
		t.Fatalf("tabs=%+v", snapshot.Tabs)
	}
}

func TestCoreProjectionLabelPrecedence(t *testing.T) {
	name := "native"
	for _, test := range []struct {
		name     string
		terminal coreTerminal
		want     *string
	}{
		{
			name:     "pairfob label wins over name",
			terminal: coreTerminal{Labels: map[string]string{corePaneLabelKey: "renamed"}, Name: &name},
			want:     stringPointer("renamed"),
		},
		{
			name:     "cleared pairfob label falls back to name",
			terminal: coreTerminal{Labels: map[string]string{corePaneLabelKey: ""}, Name: &name},
			want:     stringPointer("native"),
		},
		{name: "unlabelled", terminal: coreTerminal{}, want: nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := corePaneLabel(test.terminal)
			if got == nil || test.want == nil {
				if got != nil || test.want != nil {
					t.Fatalf("label=%v want=%v", got, test.want)
				}
				return
			}
			if *got != *test.want {
				t.Fatalf("label=%q want=%q", *got, *test.want)
			}
		})
	}
}

func TestCoreProjectionStatusMapping(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     *coreStatus
		agent      string
		display    string
		agentState string
	}{
		{name: "nil", status: nil, agent: "", display: "", agentState: ""},
		{name: "idle", status: &coreStatus{State: "idle", App: "Codex"}, agent: "codex", display: "Codex", agentState: "idle"},
		{name: "spaces", status: &coreStatus{State: "working", App: " Claude  Code "}, agent: "claude-code", display: "Claude  Code", agentState: "working"},
		{name: "blocked", status: &coreStatus{State: "blocked", App: "grok"}, agent: "grok", display: "grok", agentState: "blocked"},
		{name: "done", status: &coreStatus{State: "done", App: "grok"}, agent: "grok", display: "grok", agentState: "done"},
		{name: "error", status: &coreStatus{State: "error", App: "grok"}, agent: "grok", display: "grok", agentState: "blocked"},
		{name: "verbatim", status: &coreStatus{State: "paused", App: "grok"}, agent: "grok", display: "grok", agentState: "paused"},
	} {
		t.Run(test.name, func(t *testing.T) {
			agent, display, status := coreAgent(test.status)
			if agent != test.agent || display != test.display || status != test.agentState {
				t.Fatalf("agent=%q display=%q status=%q", agent, display, status)
			}
		})
	}
}

func TestCoreProjectionEmpty(t *testing.T) {
	snapshot := projectCoreSnapshot(newFakeCoreTransport().hello, nil, 1)
	if snapshot.HerdrVersion != "0.1.14" {
		t.Fatalf("version=%q", snapshot.HerdrVersion)
	}
	if snapshot.Workspaces == nil || snapshot.Tabs == nil || snapshot.Panes == nil || len(snapshot.Workspaces)+len(snapshot.Tabs)+len(snapshot.Panes) != 0 {
		t.Fatalf("empty snapshot=%+v", snapshot)
	}
	if snapshot.Focused == nil || len(snapshot.Focused) != 0 {
		t.Fatalf("focused=%v", snapshot.Focused)
	}
	if len(snapshot.Layouts) != 0 {
		t.Fatalf("layouts=%+v", snapshot.Layouts)
	}
}

func TestCoreCapabilityTable(t *testing.T) {
	full := coreCapabilities(coreTestMethods())
	for _, feature := range []Feature{
		FeatureSnapshot, FeaturePaneRead, FeaturePaneInput, FeatureRename, FeatureClose,
		FeatureCreateConversation, FeaturePromptAgent,
	} {
		if !full[feature].Available {
			t.Fatalf("feature %s missing from a full core", feature)
		}
	}
	for _, feature := range []Feature{
		FeatureHistory, FeatureAgentInspect, FeatureCreateTab, FeatureSplitPane,
		FeatureWorktreeList, FeatureWorktreeCreate, FeatureWorktreeOpen,
		FeatureLayoutResize, FeatureLayoutSwap, FeatureLayoutZoom,
	} {
		if full[feature].Available || full[feature].Reason == "" {
			t.Fatalf("feature %s should be unavailable with a reason: %+v", feature, full[feature])
		}
	}
	for _, test := range []struct {
		method  string
		removed []Feature
		kept    []Feature
	}{
		{method: "terminal.list", removed: []Feature{FeatureSnapshot}, kept: []Feature{FeaturePaneRead}},
		{method: "terminal.read", removed: []Feature{FeaturePaneRead}, kept: []Feature{FeatureSnapshot}},
		{method: "terminal.keys", removed: []Feature{FeaturePaneInput}, kept: []Feature{FeaturePromptAgent}},
		{method: "terminal.send", removed: []Feature{FeaturePaneInput, FeaturePromptAgent}, kept: []Feature{FeatureCreateConversation}},
		{method: "terminal.attach", removed: []Feature{FeaturePaneInput}, kept: []Feature{FeaturePromptAgent}},
		{method: "terminal.get", removed: []Feature{FeaturePaneInput}, kept: []Feature{FeaturePromptAgent}},
		{method: "terminal.label", removed: []Feature{FeatureRename}, kept: []Feature{FeatureClose}},
		{method: "terminal.kill", removed: []Feature{FeatureClose}, kept: []Feature{FeatureRename}},
		{method: "terminal.run", removed: []Feature{FeatureCreateConversation}, kept: []Feature{FeaturePromptAgent}},
	} {
		t.Run(test.method, func(t *testing.T) {
			methods := coreTestMethods()
			delete(methods, test.method)
			table := coreCapabilities(methods)
			for _, feature := range test.removed {
				if table[feature].Available {
					t.Fatalf("%s stayed available without %s", feature, test.method)
				}
			}
			for _, feature := range test.kept {
				if !table[feature].Available {
					t.Fatalf("%s was lost with only %s missing", feature, test.method)
				}
			}
		})
	}
	empty := coreCapabilities(nil)
	for _, feature := range coreAllFeatures {
		if empty[feature].Available {
			t.Fatalf("%s available on an empty method set", feature)
		}
	}
}

func TestCoreAgentKindsFiltering(t *testing.T) {
	result := coreTemplatesResult{Templates: []coreTemplate{
		{Name: "codex"}, {Name: "claude"}, {Name: "Claude"}, {Name: "1bad"},
		{Name: strings.Repeat("a", 33)}, {Name: "grok"}, {Name: "claude"}, {Name: "with space"},
	}}
	kinds := coreAgentKinds(result)
	want := []string{"claude", "codex", "grok"}
	if len(kinds) != len(want) {
		t.Fatalf("kinds=%+v", kinds)
	}
	for index, kind := range want {
		if kinds[index].Kind != kind {
			t.Fatalf("kind %d=%q want %q", index, kinds[index].Kind, kind)
		}
	}
	if empty := coreAgentKinds(coreTemplatesResult{}); empty == nil || len(empty) != 0 {
		t.Fatalf("empty kinds=%+v", empty)
	}
}

func TestCoreLiveTerminalsRejectsMalformedLists(t *testing.T) {
	valid := coreTestTerminal("t3", "live", nil)
	if terminals, err := coreLiveTerminals([]coreTerminal{valid, {Address: "t4", State: "finished"}}); err != nil || len(terminals) != 1 {
		t.Fatalf("terminals=%+v err=%v", terminals, err)
	}
	for _, test := range []struct {
		name      string
		terminals []coreTerminal
	}{
		{name: "invalid address", terminals: []coreTerminal{{Address: "dev box/t1", State: "live"}}},
		{name: "invalid state", terminals: []coreTerminal{{Address: "t3", State: "sleeping"}}},
		{name: "invalid name", terminals: []coreTerminal{{Address: "t3", State: "live", Name: stringPointer("Bad Name")}}},
		{name: "missing status state", terminals: []coreTerminal{{Address: "t3", State: "live", Status: &coreStatus{App: "codex"}}}},
		{name: "duplicate address", terminals: []coreTerminal{valid, valid}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := coreLiveTerminals(test.terminals); err == nil {
				t.Fatal("malformed terminal list was accepted")
			}
		})
	}
}

func stringPointer(value string) *string { return &value }
