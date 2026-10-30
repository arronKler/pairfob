package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCoreSendTextOpensOneStream(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	ctx := context.Background()
	first, err := core.Execute(ctx, DefaultSession(), "op-send-1", SendTextCommand{PaneID: "devbox:t7", Text: "héllo"})
	if err != nil || first.Outcome != OutcomeApplied || len(first.Updated) != 1 || first.Updated[0].ID != "devbox:t7" {
		t.Fatalf("receipt=%+v err=%v", first, err)
	}
	second, err := core.Execute(ctx, DefaultSession(), "op-send-2", SendTextCommand{PaneID: "devbox:t7", Text: " world"})
	if err != nil || second.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", second, err)
	}
	attaches := fake.attachLog()
	if len(attaches) != 1 || attaches[0].terminal != "devbox/t7" || attaches[0].cols != 80 || attaches[0].rows != 24 {
		t.Fatalf("attaches=%+v", attaches)
	}
	typed := fake.typedLog()
	if len(typed) != 2 || typed[0].channel != typed[1].channel {
		t.Fatalf("typed=%+v", typed)
	}
	if string(typed[0].data) != "héllo" || string(typed[1].data) != " world" {
		t.Fatalf("typed bytes=%q %q", typed[0].data, typed[1].data)
	}
	if strings.ContainsAny(string(typed[0].data)+string(typed[1].data), "\r\n") {
		t.Fatal("SendText submitted the text")
	}
	if gets := fake.callsOf("terminal.get"); len(gets) != 2 {
		t.Fatalf("terminal.get calls=%d, want one size check per send", len(gets))
	}
	if resizes := fake.resizeLog(); len(resizes) != 0 {
		t.Fatalf("same-size sends resized the terminal: %+v", resizes)
	}
}

func TestCoreSendTextIdleClosesStream(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	core.inputIdle = 25 * time.Millisecond
	ctx := context.Background()
	if _, err := core.Execute(ctx, DefaultSession(), "op-idle-1", SendTextCommand{PaneID: "t3", Text: "a"}); err != nil {
		t.Fatal(err)
	}
	waitForCore(t, func() bool { return len(fake.closedLog()) == 1 })
	if channel := fake.closedLog()[0]; channel != 3 {
		t.Fatalf("closed channel=%d", channel)
	}
	if _, err := core.Execute(ctx, DefaultSession(), "op-idle-2", SendTextCommand{PaneID: "t3", Text: "b"}); err != nil {
		t.Fatal(err)
	}
	if attaches := fake.attachLog(); len(attaches) != 2 {
		t.Fatalf("attaches=%d, want the stream to reopen after idle", len(attaches))
	}
	if typed := fake.typedLog(); len(typed) != 2 || typed[1].channel == typed[0].channel {
		t.Fatalf("typed=%+v", typed)
	}
}

// A shared terminal may be resized by another viewer after our stream
// attached. The next send must move the stream to the terminal's real grid
// instead of shrinking that viewer back to the stale one.
func TestCoreSendTextResizesStaleStream(t *testing.T) {
	fake := newFakeCoreTransport()
	cols, rows := 80, 24
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.get" {
			return map[string]any{"address": "t3", "state": "live", "cols": cols, "rows": rows}, nil
		}
		return coreFakeDefault(method, params)
	}
	core := newTestCore(t, fake)
	ctx := context.Background()
	if _, err := core.Execute(ctx, DefaultSession(), "op-size-1", SendTextCommand{PaneID: "t3", Text: "a"}); err != nil {
		t.Fatal(err)
	}
	cols, rows = 132, 43
	if _, err := core.Execute(ctx, DefaultSession(), "op-size-2", SendTextCommand{PaneID: "t3", Text: "b"}); err != nil {
		t.Fatal(err)
	}
	if attaches := fake.attachLog(); len(attaches) != 1 || attaches[0].cols != 80 || attaches[0].rows != 24 {
		t.Fatalf("attach=%+v", attaches)
	}
	resizes := fake.resizeLog()
	if len(resizes) != 1 || resizes[0] != (coreFakeResize{channel: 3, cols: 132, rows: 43}) {
		t.Fatalf("resizes=%+v", resizes)
	}
	typed := fake.typedLog()
	if len(typed) != 2 || typed[0].channel != typed[1].channel {
		t.Fatalf("typed=%+v", typed)
	}
	if closed := fake.closedLog(); len(closed) != 0 {
		t.Fatalf("stale-size send closed the stream: %v", closed)
	}
	if _, err := core.Execute(ctx, DefaultSession(), "op-size-3", SendTextCommand{PaneID: "t3", Text: "c"}); err != nil {
		t.Fatal(err)
	}
	if len(fake.attachLog()) != 1 || len(fake.resizeLog()) != 1 {
		t.Fatalf("attach=%d resize=%d after the size settled", len(fake.attachLog()), len(fake.resizeLog()))
	}
}

func TestCoreSendTextRejectsFinishedTerminal(t *testing.T) {
	for _, test := range []struct {
		name     string
		terminal map[string]any
	}{
		{name: "finished", terminal: map[string]any{"address": "t3", "state": "finished", "cols": 80, "rows": 24}},
		{name: "unknown size", terminal: map[string]any{"address": "t3", "state": "live", "cols": 0, "rows": 0}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeCoreTransport()
			fake.handler = func(method string, params json.RawMessage) (any, error) {
				if method == "terminal.get" {
					return test.terminal, nil
				}
				return coreFakeDefault(method, params)
			}
			receipt, err := newTestCore(t, fake).Execute(context.Background(), DefaultSession(), "op-finished", SendTextCommand{PaneID: "t3", Text: "x"})
			fault, ok := AsFault(err)
			if !ok || fault.Code != CodeNotReady || receipt.Outcome != OutcomeNotApplied {
				t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
			}
			if len(fake.attachLog()) != 0 {
				t.Fatal("attached to a terminal that cannot accept input")
			}
		})
	}
}

func TestCoreSendTextReopensClosedStream(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	ctx := context.Background()
	fake.mu.Lock()
	fake.typeErr = &coreStreamClosedError{channel: 3}
	fake.mu.Unlock()
	receipt, err := core.Execute(ctx, DefaultSession(), "op-closed-1", SendTextCommand{PaneID: "t3", Text: "a"})
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeNotReady || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
	fake.mu.Lock()
	fake.typeErr = nil
	fake.mu.Unlock()
	if _, err := core.Execute(ctx, DefaultSession(), "op-closed-2", SendTextCommand{PaneID: "t3", Text: "b"}); err != nil {
		t.Fatal(err)
	}
	if attaches := fake.attachLog(); len(attaches) != 2 {
		t.Fatalf("attaches=%d, want a fresh stream", len(attaches))
	}
}

func TestCoreSendKeys(t *testing.T) {
	fake := newFakeCoreTransport()
	var sent struct {
		Keys []string `json:"keys"`
	}
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.keys" {
			_ = json.Unmarshal(params, &sent)
			return map[string]any{"turn": 2}, nil
		}
		return coreFakeDefault(method, params)
	}
	receipt, err := newTestCore(t, fake).Execute(context.Background(), DefaultSession(), "op-keys", SendKeysCommand{
		PaneID: "t3", Keys: []string{"Enter", "ArrowUp", "ctrl+c"},
	})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if len(sent.Keys) != 3 || sent.Keys[0] != "enter" || sent.Keys[1] != "up" || sent.Keys[2] != "ctrl+c" {
		t.Fatalf("keys=%v", sent.Keys)
	}

	enter := newFakeCoreTransport()
	receipt, err = newTestCore(t, enter).Execute(context.Background(), DefaultSession(), "op-key-enter", SendKeysCommand{
		PaneID: "t3", Keys: []string{"enter"},
	})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if typed := enter.typedLog(); len(typed) != 1 || string(typed[0].data) != "\r" {
		t.Fatalf("enter typed=%+v", typed)
	}
	if calls := enter.callsOf("terminal.keys"); len(calls) != 0 {
		t.Fatalf("enter went through terminal.keys: %s", calls)
	}

	wire := newFakeCoreTransport()
	wire.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.keys" {
			return nil, &coreRPCError{Kind: "invalid_params", Message: "invalid_params: unknown key z"}
		}
		return coreFakeDefault(method, params)
	}
	_, err = newTestCore(t, wire).Execute(context.Background(), DefaultSession(), "op-key-wire", SendKeysCommand{PaneID: "t3", Keys: []string{"Z"}})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeKey {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}

	local := newFakeCoreTransport()
	receipt, err = newTestCore(t, local).Execute(context.Background(), DefaultSession(), "op-key-local", SendKeysCommand{PaneID: "t3", Keys: []string{"PageUp"}})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeInvalid || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
	if len(local.callLog()) != 0 {
		t.Fatal("an invalid key reached the core")
	}
}

func TestCoreSendKeysRawBytes(t *testing.T) {
	for _, test := range []struct {
		name  string
		keys  []string
		bytes string
	}{
		{name: "enter", keys: []string{"enter"}, bytes: "\r"},
		{name: "return alias", keys: []string{"return"}, bytes: "\r"},
		{name: "repeated enter", keys: []string{"enter", "Enter"}, bytes: "\r\r"},
		{name: "escape", keys: []string{"esc"}, bytes: "\x1b"},
		{name: "escape alias", keys: []string{"escape"}, bytes: "\x1b"},
		{name: "ctrl+c", keys: []string{"ctrl+c"}, bytes: "\x03"},
		{name: "ctrl-c alias", keys: []string{"ctrl-c"}, bytes: "\x03"},
		{name: "tab", keys: []string{"tab"}, bytes: "\t"},
		{name: "backspace", keys: []string{"backspace"}, bytes: "\x7f"},
		{name: "backspace alias", keys: []string{"bs"}, bytes: "\x7f"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeCoreTransport()
			receipt, err := newTestCore(t, fake).Execute(context.Background(), DefaultSession(), "op-raw", SendKeysCommand{PaneID: "t3", Keys: test.keys})
			if err != nil || receipt.Outcome != OutcomeApplied {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			typed := fake.typedLog()
			if len(typed) != 1 || typed[0].channel != 3 || string(typed[0].data) != test.bytes {
				t.Fatalf("typed=%+v want %q", typed, test.bytes)
			}
			if calls := fake.callsOf("terminal.keys"); len(calls) != 0 {
				t.Fatalf("raw key went through terminal.keys: %s", calls)
			}
			if calls := fake.callsOf("terminal.interrupt"); len(calls) != 0 {
				t.Fatalf("raw key became an interrupt: %s", calls)
			}
		})
	}

	// One key terminal.keys alone can encode keeps the whole batch, so nothing
	// is written before the bytes that depend on the program's modes.
	mixed := newFakeCoreTransport()
	receipt, err := newTestCore(t, mixed).Execute(context.Background(), DefaultSession(), "op-raw-mixed", SendKeysCommand{
		PaneID: "t3", Keys: []string{"enter", "up"},
	})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if typed := mixed.typedLog(); len(typed) != 0 {
		t.Fatalf("mixed batch typed raw bytes: %+v", typed)
	}
	if calls := mixed.callsOf("terminal.keys"); len(calls) != 1 {
		t.Fatalf("terminal.keys calls=%d", len(calls))
	}
}

func TestCoreRenamePane(t *testing.T) {
	fake := newFakeCoreTransport()
	var labels map[string]string
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.label" {
			var request struct {
				Terminal string            `json:"terminal"`
				Labels   map[string]string `json:"labels"`
			}
			_ = json.Unmarshal(params, &request)
			labels = request.Labels
			return map[string]any{"address": request.Terminal, "state": "live", "labels": request.Labels}, nil
		}
		return coreFakeDefault(method, params)
	}
	core := newTestCore(t, fake)
	label := "new name"
	receipt, err := core.Execute(context.Background(), DefaultSession(), "op-rename", RenamePaneCommand{PaneID: "t3", Label: &label})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if labels[corePaneLabelKey] != "new name" {
		t.Fatalf("labels=%v", labels)
	}
	if _, err := core.Execute(context.Background(), DefaultSession(), "op-rename-clear", RenamePaneCommand{PaneID: "t3"}); err != nil {
		t.Fatal(err)
	}
	if len(labels) != 1 || labels[corePaneLabelKey] != "" {
		t.Fatalf("clear labels=%v", labels)
	}

	mismatch := newFakeCoreTransport()
	mismatch.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.label" {
			return map[string]any{"address": "t9", "state": "live"}, nil
		}
		return coreFakeDefault(method, params)
	}
	receipt, err = newTestCore(t, mismatch).Execute(context.Background(), DefaultSession(), "op-rename-mismatch", RenamePaneCommand{PaneID: "t3", Label: &label})
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeInternal || receipt.Outcome != OutcomeUnknown {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
}

func TestCoreClosePane(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	ctx := context.Background()
	if _, err := core.Execute(ctx, DefaultSession(), "op-close-open", SendTextCommand{PaneID: "t3", Text: "x"}); err != nil {
		t.Fatal(err)
	}
	receipt, err := core.Execute(ctx, DefaultSession(), "op-close", ClosePaneCommand{PaneID: "t3"})
	if err != nil || receipt.Outcome != OutcomeApplied || len(receipt.Removed) != 1 || receipt.Removed[0].ID != "t3" {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if closed := fake.closedLog(); len(closed) != 1 || closed[0] != 3 {
		t.Fatalf("closed=%v", closed)
	}
	if kills := fake.callsOf("terminal.kill"); len(kills) != 1 || string(kills[0]) != `{"terminal":"t3"}` {
		t.Fatalf("kills=%v", kills)
	}
	if removed := fake.callsOf("terminal.rm"); len(removed) != 1 || string(removed[0]) != `{"terminal":"t3"}` {
		t.Fatalf("rm=%v", removed)
	}

	finished := newFakeCoreTransport()
	finished.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.kill" {
			return nil, &coreRPCError{Kind: "finished", Message: "finished"}
		}
		return coreFakeDefault(method, params)
	}
	receipt, err = newTestCore(t, finished).Execute(context.Background(), DefaultSession(), "op-close-finished", ClosePaneCommand{PaneID: "t3"})
	if err != nil || receipt.Outcome != OutcomeNoop || len(receipt.Removed) != 1 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if removed := finished.callsOf("terminal.rm"); len(removed) != 1 {
		t.Fatalf("the finished record was not released: %v", removed)
	}

	missing := newFakeCoreTransport()
	missing.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.kill" {
			return nil, &coreRPCError{Kind: "not_found", Message: "not_found"}
		}
		return coreFakeDefault(method, params)
	}
	receipt, err = newTestCore(t, missing).Execute(context.Background(), DefaultSession(), "op-close-missing", ClosePaneCommand{PaneID: "t3"})
	if err != nil || receipt.Outcome != OutcomeNoop || len(receipt.Removed) != 1 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}

	stuckRecord := newFakeCoreTransport()
	stuckRecord.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.rm" {
			return nil, &coreRPCError{Kind: "conflict", Message: "conflict"}
		}
		return coreFakeDefault(method, params)
	}
	receipt, err = newTestCore(t, stuckRecord).Execute(context.Background(), DefaultSession(), "op-close-stuck", ClosePaneCommand{PaneID: "t3"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeConflict || receipt.Outcome != OutcomePartial {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}

	noRm := newFakeCoreTransport()
	delete(noRm.hello.Methods, "terminal.rm")
	receipt, err = newTestCore(t, noRm).Execute(context.Background(), DefaultSession(), "op-close-no-rm", ClosePaneCommand{PaneID: "t3"})
	if err != nil || receipt.Outcome != OutcomeApplied || len(receipt.Removed) != 1 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if calls := noRm.callsOf("terminal.rm"); len(calls) != 0 {
		t.Fatalf("rm was sent to a core without it: %v", calls)
	}

	emptyRm := newFakeCoreTransport()
	emptyRm.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.rm" {
			return map[string]any{"removed": ""}, nil
		}
		return coreFakeDefault(method, params)
	}
	receipt, err = newTestCore(t, emptyRm).Execute(context.Background(), DefaultSession(), "op-close-empty-rm", ClosePaneCommand{PaneID: "t3"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeInternal || receipt.Outcome != OutcomeUnknown {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
}

func TestCoreCreateConversation(t *testing.T) {
	fake := newFakeCoreTransport()
	var run map[string]any
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.run" {
			_ = json.Unmarshal(params, &run)
			return map[string]any{"address": "t9", "state": "live"}, nil
		}
		return coreFakeDefault(method, params)
	}
	receipt, err := newTestCore(t, fake).Execute(context.Background(), DefaultSession(), "op-create",
		CreateConversationCommand{CWD: "/repo", Label: "shell", AgentKind: "codex"})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	argv, _ := run["argv"].([]any)
	if len(argv) != 1 || argv[0] != "codex" || run["cwd"] != "/repo" {
		t.Fatalf("run params=%v", run)
	}
	labels, _ := run["labels"].(map[string]any)
	if labels[corePaneLabelKey] != "shell" {
		t.Fatalf("labels=%v", run["labels"])
	}
	if _, exists := run["on"]; exists {
		t.Fatalf("local create sent on=%v", run["on"])
	}
	if len(receipt.Created) != 3 || receipt.Created[0].ID != "core" || receipt.Created[1].ID != "term:t9" || receipt.Created[2].ID != "t9" {
		t.Fatalf("created=%+v", receipt.Created)
	}

	relative := newFakeCoreTransport()
	receipt, err = newTestCore(t, relative).Execute(context.Background(), DefaultSession(), "op-create-relative",
		CreateConversationCommand{CWD: "repo"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeInvalid || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
	if len(relative.callLog()) != 0 {
		t.Fatal("a relative cwd reached the core")
	}

	invalid := newFakeCoreTransport()
	invalid.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.run" {
			return nil, &coreRPCError{Kind: "invalid_template", Message: "invalid_template"}
		}
		return coreFakeDefault(method, params)
	}
	_, err = newTestCore(t, invalid).Execute(context.Background(), DefaultSession(), "op-create-invalid",
		CreateConversationCommand{AgentKind: "nope"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeUnsupported {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}

func TestCoreConversationParamsRemoteTarget(t *testing.T) {
	params, err := coreConversationParams(CreateConversationCommand{CWD: "/repo", Label: "shell"}, "machine:devbox")
	if err != nil {
		t.Fatal(err)
	}
	if params["on"] != "devbox" || params["cwd"] != "/repo" {
		t.Fatalf("params=%v", params)
	}
	if local, err := coreConversationParams(CreateConversationCommand{}, "core"); err != nil {
		t.Fatal(err)
	} else if _, exists := local["on"]; exists {
		t.Fatalf("local params=%v", local)
	}
	if _, err := coreConversationParams(CreateConversationCommand{}, "machine:"); err == nil {
		t.Fatal("empty machine was accepted")
	}
	if _, err := coreConversationParams(CreateConversationCommand{}, "elsewhere"); err == nil {
		t.Fatal("unknown workspace was accepted")
	}
}

func TestCorePromptAgent(t *testing.T) {
	fake := newFakeCoreTransport()
	var sent map[string]any
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.send" {
			_ = json.Unmarshal(params, &sent)
			return map[string]any{"turn": 3}, nil
		}
		return coreFakeDefault(method, params)
	}
	receipt, err := newTestCore(t, fake).Execute(context.Background(), DefaultSession(), "op-prompt",
		PromptAgentCommand{Target: "devbox:t7", Text: "continue"})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if sent["terminal"] != "devbox/t7" || sent["text"] != "continue" || sent["force"] != true {
		t.Fatalf("send params=%v", sent)
	}

	blocked := newFakeCoreTransport()
	blocked.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.send" {
			return nil, &coreRPCError{Kind: "blocked", Message: "blocked"}
		}
		return coreFakeDefault(method, params)
	}
	receipt, err = newTestCore(t, blocked).Execute(context.Background(), DefaultSession(), "op-prompt-blocked",
		PromptAgentCommand{Target: "t3", Text: "go"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeBlocked || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}

	empty := newFakeCoreTransport()
	receipt, err = newTestCore(t, empty).Execute(context.Background(), DefaultSession(), "op-prompt-empty",
		PromptAgentCommand{Target: "t3"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeInvalid || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
}

func TestCoreUnsupportedCommands(t *testing.T) {
	commands := []Command{
		RenameTabCommand{TabID: "term:t3", Label: "x"},
		RenameWorkspaceCommand{WorkspaceID: "core", Label: "x"},
		CloseTabCommand{TabID: "term:t3"},
		CloseWorkspaceCommand{WorkspaceID: "core"},
		CreateTabCommand{WorkspaceID: "core"},
		SplitPaneCommand{TargetPaneID: "t3", Direction: SplitRight},
		WorktreeCreateCommand{WorkspaceID: "core"},
		WorktreeOpenCommand{WorkspaceID: "core"},
		ResizePaneCommand{PaneID: "t3", Direction: PaneRight},
		SwapPaneCommand{PaneID: "t3", Direction: PaneLeft},
		ZoomPaneCommand{PaneID: "t3", Mode: ZoomToggle},
	}
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	for index, command := range commands {
		receipt, err := core.Execute(context.Background(), DefaultSession(), "op-unsupported-"+string(rune('a'+index)), command)
		fault, ok := AsFault(err)
		if !ok || fault.Code != CodeUnsupported || fault.Outcome != OutcomeNotApplied || receipt.Outcome != OutcomeNotApplied {
			t.Fatalf("command %T receipt=%+v fault=%+v err=%v", command, receipt, fault, err)
		}
	}
	if calls := fake.callLog(); len(calls) != 0 {
		t.Fatalf("unsupported commands reached the core: %+v", calls)
	}
}

func TestCoreInvalidOperationID(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	for _, operationID := range []string{"", strings.Repeat("a", 129), "\xff"} {
		receipt, err := core.Execute(context.Background(), DefaultSession(), operationID, SendTextCommand{PaneID: "t3", Text: "x"})
		fault, ok := AsFault(err)
		if !ok || fault.Code != CodeInvalid || receipt.Outcome != OutcomeNotApplied {
			t.Fatalf("operation %q receipt=%+v fault=%+v err=%v", operationID, receipt, fault, err)
		}
	}
	if calls := fake.callLog(); len(calls) != 0 {
		t.Fatalf("invalid operation ids reached the core: %+v", calls)
	}
}

func TestCoreNamedSessionUnsupported(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	if _, err := core.Describe(context.Background(), NamedSession("work")); err == nil {
		t.Fatal("Describe accepted a named session")
	}
	if _, err := core.Observe(context.Background(), NamedSession("work"), SnapshotQuery{}); err == nil {
		t.Fatal("Observe accepted a named session")
	}
	receipt, err := core.Execute(context.Background(), NamedSession("work"), "op-named", SendTextCommand{PaneID: "t3", Text: "x"})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeUnsupported || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
}

func TestCoreFaultMapping(t *testing.T) {
	for _, test := range []struct {
		name    string
		err     error
		code    ErrorCode
		outcome Outcome
		retry   RetryAdvice
	}{
		{name: "not found", err: &coreRPCError{Kind: "not_found"}, code: CodeNotFound, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "machine unknown", err: &coreRPCError{Kind: "machine_unknown"}, code: CodeNotFound, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "unknown key", err: &coreRPCError{Kind: "invalid_params", Message: "invalid_params: unknown key f13"}, code: CodeKey, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "invalid", err: &coreRPCError{Kind: "invalid_params", Message: "invalid_params"}, code: CodeInvalid, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "name taken", err: &coreRPCError{Kind: "name_taken"}, code: CodeConflict, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "finished", err: &coreRPCError{Kind: "finished"}, code: CodeNotReady, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "blocked", err: &coreRPCError{Kind: "blocked"}, code: CodeBlocked, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "status mismatch", err: &coreRPCError{Kind: "status_mismatch"}, code: CodeStale, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "needs framed", err: &coreRPCError{Kind: "needs_framed"}, code: CodeUnsupported, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "refused", err: &coreRPCError{Kind: "refused"}, code: CodeUnsupported, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "spawn failed", err: &coreRPCError{Kind: "spawn_failed"}, code: CodeNotReady, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "unavailable", err: &coreRPCError{Kind: "unavailable"}, code: CodeNotReady, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "unknown kind", err: &coreRPCError{Kind: "weird"}, code: CodeInternal, outcome: OutcomeNotApplied, retry: RetryNever},
		{name: "eof", err: &coreTransportError{cause: errors.New("EOF")}, code: CodeOffline, outcome: OutcomeUnknown, retry: RetryUserOnly},
		{name: "timeout", err: &coreTransportError{cause: context.DeadlineExceeded, timeout: true}, code: CodeTimeout, outcome: OutcomeUnknown, retry: RetryUserOnly},
		{name: "deadline", err: context.DeadlineExceeded, code: CodeTimeout, outcome: OutcomeUnknown, retry: RetryUserOnly},
		{name: "protocol", err: coreProtocol("op", "bad"), code: CodeInternal, outcome: OutcomeUnknown, retry: RetryUserOnly},
		{name: "stream closed", err: &coreStreamClosedError{channel: 3}, code: CodeNotReady, outcome: OutcomeNotApplied, retry: RetryNever},
	} {
		t.Run(test.name, func(t *testing.T) {
			fault, ok := AsFault(coreFault("pane.send_text", test.err, true, true))
			if !ok || fault.Code != test.code || fault.Outcome != test.outcome || fault.Retry != test.retry {
				t.Fatalf("fault=%+v", fault)
			}
		})
	}
	readFault, _ := AsFault(coreFault("pane.read", &coreTransportError{cause: errors.New("EOF")}, false, false))
	if readFault.Outcome != OutcomeNotApplied || readFault.Retry != RetryReadSafe {
		t.Fatalf("read fault=%+v", readFault)
	}
	unsent, _ := AsFault(coreFault("pane.send_text", &coreTransportError{cause: errors.New("EOF")}, true, false))
	if unsent.Outcome != OutcomeNotApplied || unsent.Retry != RetryUserOnly {
		t.Fatalf("unsent fault=%+v", unsent)
	}
}

// Core.Close must interrupt a send that is still negotiating its stream: the
// stream is released and no bytes reach the core.
func TestCoreCloseDuringSendText(t *testing.T) {
	fake := newFakeCoreTransport()
	blocked := make(chan struct{})
	release := make(chan struct{})
	fake.handler = func(method string, params json.RawMessage) (any, error) {
		if method == "terminal.get" {
			close(blocked)
			<-release
		}
		return coreFakeDefault(method, params)
	}
	core := newTestCore(t, fake)
	done := make(chan error, 1)
	go func() {
		_, err := core.Execute(context.Background(), DefaultSession(), "op-close-race", SendTextCommand{PaneID: "t3", Text: "echo hi"})
		done <- err
	}()
	waitForCore(t, func() bool {
		select {
		case <-blocked:
			return true
		default:
			return false
		}
	})
	if err := core.Close(); err != nil {
		t.Fatal(err)
	}
	close(release)
	fault, ok := AsFault(<-done)
	if !ok || fault.Code != CodeOffline || fault.Outcome != OutcomeNotApplied {
		t.Fatalf("fault=%+v", fault)
	}
	if typed := fake.typedLog(); len(typed) != 0 {
		t.Fatalf("typed after close: %+v", typed)
	}
	if closed := fake.closedLog(); len(closed) != 1 || closed[0] != 3 {
		t.Fatalf("stream was not released: %v", closed)
	}
}
