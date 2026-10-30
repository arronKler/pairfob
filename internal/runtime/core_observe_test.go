package runtime

import (
	"context"
	"encoding/json"
	"testing"
)

func TestCoreObserveSnapshot(t *testing.T) {
	fake := newFakeCoreTransport()
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		switch method {
		case "terminal.list":
			return map[string]any{
				"terminals": []any{
					map[string]any{"address": "t3", "state": "live", "cwd": "/repo", "cols": 100, "rows": 30, "title": "vim", "labels": map[string]string{},
						"foreground": map[string]any{"cwd": "/repo/src"}},
					map[string]any{"address": "devbox/t7", "state": "live", "cwd": "/srv", "cols": 80, "rows": 24, "status": map[string]any{"state": "working", "app": "codex"}},
				},
				"hidden_finished": 2, "machines": []any{},
			}, nil
		}
		return coreFakeDefault(method, params)
	}
	core := newTestCore(t, fake)
	view, err := core.Observe(context.Background(), DefaultSession(), SnapshotQuery{})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := view.(SnapshotView).Snapshot
	if snapshot.HerdrVersion != "0.1.14" || snapshot.HerdrProtocol != 2 {
		t.Fatalf("snapshot metadata=%+v", snapshot)
	}
	if len(snapshot.Workspaces) != 2 || len(snapshot.Panes) != 2 || len(snapshot.Layouts) != 2 {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	if snapshot.Panes[0].Cwd != "/repo/src" || snapshot.Panes[0].Scroll == nil || snapshot.Panes[0].Scroll.ViewportRows != 30 {
		t.Fatalf("local pane=%+v", snapshot.Panes[0])
	}
	if snapshot.Panes[1].AgentStatus != "working" || snapshot.Panes[1].Agent != "codex" {
		t.Fatalf("remote pane=%+v", snapshot.Panes[1])
	}
	if snapshot.Panes[1].Cwd != "" || snapshot.Panes[1].Tokens["cwd"] != "/srv" {
		t.Fatalf("remote cwd=%q tokens=%v", snapshot.Panes[1].Cwd, snapshot.Panes[1].Tokens)
	}
	if len(snapshot.Focused) != 0 {
		t.Fatalf("focused=%v", snapshot.Focused)
	}
	params := fake.callsOf("terminal.list")
	if len(params) != 1 || string(params[0]) != `{"all":false}` {
		t.Fatalf("terminal.list params=%s", params)
	}
	if calls := fake.callsOf("server.status"); len(calls) != 0 {
		t.Fatalf("snapshot asked for server.status: %s", calls)
	}
}

func TestCoreObserveSnapshotMalformed(t *testing.T) {
	for _, test := range []struct {
		name  string
		value map[string]any
	}{
		{name: "missing terminals", value: map[string]any{"machines": []any{}}},
		{name: "null terminals", value: map[string]any{"terminals": nil}},
		{name: "invalid address", value: map[string]any{"terminals": []any{map[string]any{"address": "dev box/t1", "state": "live"}}}},
		{name: "invalid state", value: map[string]any{"terminals": []any{map[string]any{"address": "t1", "state": "sleeping"}}}},
		{name: "duplicate address", value: map[string]any{"terminals": []any{
			map[string]any{"address": "t1", "state": "live"},
			map[string]any{"address": "t1", "state": "live"},
		}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeCoreTransport()
			fake.handler = func(method string, params json.RawMessage) (any, error) {
				if method == "terminal.list" {
					return test.value, nil
				}
				return coreFakeDefault(method, params)
			}
			core := newTestCore(t, fake)
			_, err := core.Observe(context.Background(), DefaultSession(), SnapshotQuery{})
			fault, ok := AsFault(err)
			if !ok || fault.Code != CodeInternal || fault.Outcome != OutcomeNotApplied {
				t.Fatalf("fault=%+v err=%v", fault, err)
			}
			if fake.closeCount() == 0 {
				t.Fatal("malformed snapshot kept the connection")
			}
		})
	}
}

func TestCoreObservePaneRead(t *testing.T) {
	fake := newFakeCoreTransport()
	var lines []float64
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method != "terminal.read" {
			return coreFakeDefault(method, params)
		}
		var request struct {
			Terminal string  `json:"terminal"`
			Lines    float64 `json:"lines"`
		}
		_ = json.Unmarshal(params, &request)
		lines = append(lines, request.Lines)
		return map[string]any{
			"text": "ready\n", "complete": request.Lines != 200, "how": "stitched",
		}, nil
	}
	core := newTestCore(t, fake)
	visible, err := core.Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "t3", Source: SourceVisible, Format: FormatANSI, Lines: 500})
	if err != nil || visible.(PaneReadView).Text != "ready\n" || visible.(PaneReadView).Truncated {
		t.Fatalf("visible=%+v err=%v", visible, err)
	}
	recent, err := core.Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "devbox:t7", Source: SourceRecent, Lines: 200})
	if err != nil || !recent.(PaneReadView).Truncated {
		t.Fatalf("recent=%+v err=%v", recent, err)
	}
	if _, err := core.Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "t3", Source: SourceRecentUnwrapped, Lines: 9000}); err != nil {
		t.Fatal(err)
	}
	if _, err := core.Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "t3", Source: SourceRecent, Lines: -5}); err != nil {
		t.Fatal(err)
	}
	want := []float64{0, 200, 4096, 0}
	if len(lines) != len(want) {
		t.Fatalf("lines=%v", lines)
	}
	for index, value := range want {
		if lines[index] != value {
			t.Fatalf("lines[%d]=%v want %v", index, lines[index], value)
		}
	}
	if calls := fake.callsOf("terminal.read"); len(calls) != 4 || !json.Valid(calls[1]) {
		t.Fatalf("terminal.read calls=%v", calls)
	}
}

func TestCoreObservePaneReadFaults(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		read map[string]any
		code ErrorCode
	}{
		{name: "not found", err: &coreRPCError{Kind: "not_found", Message: "not_found"}, code: CodeNotFound},
		{name: "machine unknown", err: &coreRPCError{Kind: "machine_unknown", Message: "machine_unknown"}, code: CodeNotFound},
		{name: "finished", err: &coreRPCError{Kind: "finished", Message: "finished"}, code: CodeNotReady},
		{name: "invalid response", read: map[string]any{"text": "x", "complete": true, "how": "pixels"}, code: CodeInternal},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeCoreTransport()
			fake.handler = func(method string, params json.RawMessage) (any, error) {
				if method != "terminal.read" {
					return coreFakeDefault(method, params)
				}
				return test.read, test.err
			}
			core := newTestCore(t, fake)
			_, err := core.Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "t3"})
			fault, ok := AsFault(err)
			if !ok || fault.Code != test.code {
				t.Fatalf("fault=%+v err=%v", fault, err)
			}
		})
	}

	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	for _, query := range []PaneReadQuery{
		{PaneID: "bad/id"},
		{PaneID: "t3", Source: "everything"},
		{PaneID: "t3", Format: "html"},
	} {
		_, err := core.Observe(context.Background(), DefaultSession(), query)
		fault, ok := AsFault(err)
		if !ok || fault.Code != CodeInvalid {
			t.Fatalf("query %+v fault=%+v err=%v", query, fault, err)
		}
	}
	if calls := fake.callLog(); len(calls) != 0 {
		t.Fatalf("invalid reads reached the core: %+v", calls)
	}
}

func TestCoreObserveUnsupported(t *testing.T) {
	core := newTestCore(t, newFakeCoreTransport())
	if _, err := core.Observe(context.Background(), DefaultSession(), HistoryQuery{PaneID: "t3"}); err == nil {
		t.Fatal("history was accepted")
	}
	if _, err := core.Observe(context.Background(), DefaultSession(), WorktreeListQuery{}); err == nil {
		t.Fatal("worktree list was accepted")
	}
	if _, err := core.Observe(context.Background(), NamedSession("work"), SnapshotQuery{}); err == nil {
		t.Fatal("named session was accepted")
	}

	missingList := newFakeCoreTransport()
	delete(missingList.hello.Methods, "terminal.list")
	if _, err := newTestCore(t, missingList).Observe(context.Background(), DefaultSession(), SnapshotQuery{}); err == nil {
		t.Fatal("snapshot without terminal.list was accepted")
	}
	missingRead := newFakeCoreTransport()
	delete(missingRead.hello.Methods, "terminal.read")
	if _, err := newTestCore(t, missingRead).Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "t3"}); err == nil {
		t.Fatal("pane read without terminal.read was accepted")
	}
}

func TestCoreDescribeUsesHelloAndTemplates(t *testing.T) {
	fake := newFakeCoreTransport()
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "templates.list" {
			return map[string]any{"templates": []any{
				map[string]any{"name": "codex", "description": "", "command": "codex"},
				map[string]any{"name": "Bad Name", "description": "", "command": "x"},
			}}, nil
		}
		return coreFakeDefault(method, params)
	}
	descriptor, err := newTestCore(t, fake).Describe(context.Background(), DefaultSession())
	if err != nil {
		t.Fatal(err)
	}
	if descriptor.Runtime != "herdr-core" || descriptor.Version != "0.1.14" || descriptor.Protocol != 2 {
		t.Fatalf("descriptor=%+v", descriptor)
	}
	if len(descriptor.AgentKinds) != 1 || descriptor.AgentKinds[0].Kind != "codex" {
		t.Fatalf("agent kinds=%+v", descriptor.AgentKinds)
	}
	if !descriptor.Supports(FeatureSnapshot) || !descriptor.Supports(FeaturePromptAgent) || descriptor.Supports(FeatureHistory) {
		t.Fatalf("capabilities=%+v", descriptor.Capabilities)
	}
	if calls := fake.callsOf("server.status"); len(calls) != 0 {
		t.Fatalf("describe asked for server.status: %s", calls)
	}
}

func TestCoreDescribeToleratesTemplateFailure(t *testing.T) {
	fake := newFakeCoreTransport()
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "templates.list" {
			return nil, &coreRPCError{Kind: "config", Message: "config"}
		}
		return coreFakeDefault(method, params)
	}
	descriptor, err := newTestCore(t, fake).Describe(context.Background(), DefaultSession())
	if err != nil {
		t.Fatal(err)
	}
	if descriptor.Version != "0.1.14" || len(descriptor.AgentKinds) != 0 {
		t.Fatalf("descriptor=%+v", descriptor)
	}
	if !descriptor.Supports(FeatureSnapshot) {
		t.Fatalf("capabilities=%+v", descriptor.Capabilities)
	}
}
