package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type scriptedRequest struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type scriptedError struct {
	Code    string
	Message string
}

type scriptedReply struct {
	Result any
	Error  *scriptedError
	Delay  time.Duration
}

type requestLog struct {
	mu       sync.Mutex
	requests []scriptedRequest
}

func (l *requestLog) append(request scriptedRequest) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = append(l.requests, request)
}

func (l *requestLog) snapshot() []scriptedRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]scriptedRequest(nil), l.requests...)
}

func startScriptedHerdr(t *testing.T, handler func(scriptedRequest) scriptedReply) (string, *requestLog) {
	t.Helper()
	socket := shortTestSocket(t)
	return socket, startScriptedHerdrAt(t, socket, handler)
}

func shortTestSocket(t *testing.T) string {
	t.Helper()
	temporary, err := os.CreateTemp("", "pfh-*.sock")
	if err != nil {
		t.Fatal(err)
	}
	socket := temporary.Name()
	_ = temporary.Close()
	_ = os.Remove(socket)
	t.Cleanup(func() { _ = os.Remove(socket) })
	return socket
}

func startScriptedHerdrAt(t *testing.T, socket string, handler func(scriptedRequest) scriptedReply) *requestLog {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.Remove(socket)
	})
	log := &requestLog{}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func(connection net.Conn) {
				defer connection.Close()
				scanner := bufio.NewScanner(connection)
				if !scanner.Scan() {
					return
				}
				var request scriptedRequest
				if json.Unmarshal(scanner.Bytes(), &request) != nil {
					return
				}
				log.append(request)
				reply := handler(request)
				if reply.Delay > 0 {
					time.Sleep(reply.Delay)
				}
				var envelope any
				if reply.Error != nil {
					envelope = map[string]any{"id": request.ID, "error": map[string]string{"code": reply.Error.Code, "message": reply.Error.Message}}
				} else {
					envelope = map[string]any{"id": request.ID, "result": reply.Result}
				}
				raw, _ := json.Marshal(envelope)
				_, _ = connection.Write(append(raw, '\n'))
			}(connection)
		}
	}()
	return log
}

func standardReply(request scriptedRequest) scriptedReply {
	switch request.Method {
	case "session.snapshot":
		return scriptedReply{Result: map[string]any{
			"type": "session_snapshot",
			"snapshot": map[string]any{
				"version": "0.8.0", "protocol": 19,
				"focused_workspace_id": "w1", "focused_tab_id": "w1:t1", "focused_pane_id": "w1:p1",
				"workspaces": []any{map[string]any{"workspace_id": "w1", "number": 1, "label": "lab", "agent_status": "blocked"}},
				"tabs":       []any{map[string]any{"tab_id": "w1:t1", "workspace_id": "w1", "label": "main"}},
				"panes": []any{map[string]any{
					"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "cwd": "/tmp/lab",
					"agent": "codex", "agent_status": "blocked",
					"agent_session": map[string]any{"source": "hook", "agent": "codex", "kind": "id", "value": "secret-transcript-id"},
				}},
			},
		}}
	case "server.agent_manifests":
		return scriptedReply{Result: map[string]any{"type": "agent_manifest_status", "manifests": []any{
			map[string]any{"agent": "codex"}, map[string]any{"agent": "claude"},
		}}}
	case "pane.read":
		return scriptedReply{Result: map[string]any{"type": "pane_read", "read": map[string]any{"text": "ready", "truncated": false}}}
	case "pane.send_text", "pane.send_keys", "pane.rename", "tab.rename", "workspace.rename", "pane.close", "tab.close", "workspace.close":
		return scriptedReply{Result: map[string]any{"type": "ok"}}
	case "workspace.create":
		return scriptedReply{Result: workspaceCreatedResult()}
	case "agent.start":
		return scriptedReply{Result: map[string]any{"type": "agent_started", "agent": map[string]any{"pane_id": "w2:p1", "name": "codex-test"}, "argv": []string{"codex"}}}
	case "tab.create":
		return scriptedReply{Result: map[string]any{
			"type": "tab_created", "tab": map[string]any{"tab_id": "w1:t2", "workspace_id": "w1", "label": "two"},
			"root_pane": map[string]any{"pane_id": "w1:p2", "workspace_id": "w1", "tab_id": "w1:t2"},
		}}
	case "pane.split":
		return scriptedReply{Result: map[string]any{"type": "pane_info", "pane": map[string]any{"pane_id": "w1:p2", "workspace_id": "w1", "tab_id": "w1:t1"}}}
	case "agent.prompt":
		return scriptedReply{Result: map[string]any{"type": "agent_prompted", "agent": map[string]any{"pane_id": "w1:p1", "name": "codex-test"}}}
	case "worktree.list":
		branch := "feature"
		return scriptedReply{Result: map[string]any{
			"type":      "worktree_list",
			"source":    map[string]any{"repo_key": "repo", "repo_name": "project", "repo_root": "/repo", "source_checkout_path": "/repo", "source_workspace_id": "w1"},
			"worktrees": []any{map[string]any{"path": "/repo-feature", "branch": branch, "label": "feature", "is_bare": false, "is_detached": false, "is_prunable": false, "is_linked_worktree": true}},
		}}
	case "worktree.create":
		return scriptedReply{Result: worktreeChangedResult("worktree_created", false)}
	case "worktree.open":
		return scriptedReply{Result: worktreeChangedResult("worktree_opened", false)}
	case "pane.resize":
		return scriptedReply{Result: map[string]any{"type": "pane_resize", "resize": map[string]any{"changed": true}}}
	case "pane.swap":
		return scriptedReply{Result: map[string]any{"type": "pane_swap", "swap": map[string]any{"changed": true}}}
	case "pane.zoom":
		return scriptedReply{Result: map[string]any{"type": "pane_zoom", "zoom": map[string]any{"changed": false}}}
	default:
		return scriptedReply{Error: &scriptedError{Code: "unknown", Message: request.Method}}
	}
}

func workspaceCreatedResult() map[string]any {
	return map[string]any{
		"type":      "workspace_created",
		"workspace": map[string]any{"workspace_id": "w2", "number": 2, "label": "new"},
		"tab":       map[string]any{"tab_id": "w2:t1", "workspace_id": "w2", "label": "main"},
		"root_pane": map[string]any{"pane_id": "w2:p1", "workspace_id": "w2", "tab_id": "w2:t1"},
	}
}

func worktreeChangedResult(resultType string, alreadyOpen bool) map[string]any {
	return map[string]any{
		"type":      resultType,
		"workspace": map[string]any{"workspace_id": "w3", "number": 3, "label": "feature"},
		"tab":       map[string]any{"tab_id": "w3:t1", "workspace_id": "w3", "label": "main"},
		"root_pane": map[string]any{"pane_id": "w3:p1", "workspace_id": "w3", "tab_id": "w3:t1"},
		"worktree":  map[string]any{"path": "/repo-feature"}, "already_open": alreadyOpen,
	}
}

func TestHerdrDeepRuntimeCoversTypedQueriesAndCommands(t *testing.T) {
	socket, log := startScriptedHerdr(t, standardReply)
	herdr := NewHerdr(socket)
	var _ Runtime = herdr
	ctx := context.Background()
	descriptor, err := herdr.Describe(ctx, DefaultSession())
	if err != nil || descriptor.Protocol != 19 || !descriptor.Supports(FeatureCreateConversation) || len(descriptor.AgentKinds) != 2 {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
	view, err := herdr.Observe(ctx, DefaultSession(), SnapshotQuery{})
	if err != nil {
		t.Fatal(err)
	}
	pane := view.(SnapshotView).Snapshot.Panes[0]
	workspace := view.(SnapshotView).Snapshot.Workspaces[0]
	if workspace.Cwd != "" || pane.Cwd != "/tmp/lab" {
		t.Fatalf("protocol 19 cwd mapping drifted: workspace=%+v pane=%+v", workspace, pane)
	}
	if pane.AgentSession == nil || pane.AgentSession.Value != "secret-transcript-id" || !pane.HistoryAvailable {
		t.Fatalf("pane=%+v", pane)
	}
	encoded, _ := json.Marshal(pane)
	if strings.Contains(string(encoded), "secret-transcript-id") || !strings.Contains(string(encoded), `"history_available":true`) {
		t.Fatalf("trusted binding leaked or availability missing: %s", encoded)
	}
	read, err := herdr.Observe(ctx, DefaultSession(), PaneReadQuery{PaneID: "w1:p1", Source: SourceVisible, Format: FormatText})
	if err != nil || read.(PaneReadView).Text != "ready" {
		t.Fatalf("read=%+v err=%v", read, err)
	}
	if _, err := herdr.Observe(ctx, DefaultSession(), PaneReadQuery{PaneID: "w1:p1", Source: SourceRecentUnwrapped, Format: FormatText, Lines: 200}); err != nil {
		t.Fatal(err)
	}
	foundRecent := false
	for _, request := range log.snapshot() {
		if request.Method != "pane.read" {
			continue
		}
		var params map[string]any
		if json.Unmarshal(request.Params, &params) == nil && params["source"] == SourceRecentUnwrapped && params["lines"] == float64(200) {
			foundRecent = true
		}
	}
	if !foundRecent {
		t.Fatal("recent_unwrapped pane read was not sent to Herdr")
	}
	worktrees, err := herdr.Observe(ctx, DefaultSession(), WorktreeListQuery{WorkspaceID: "w1"})
	if err != nil || len(worktrees.(WorktreeListView).Worktrees) != 1 {
		t.Fatalf("worktrees=%+v err=%v", worktrees, err)
	}
	commands := []Command{
		SendTextCommand{PaneID: "w1:p1", Text: "hello"},
		SendKeysCommand{PaneID: "w1:p1", Keys: []string{"Enter"}},
		RenamePaneCommand{PaneID: "w1:p1"},
		RenameTabCommand{TabID: "w1:t1", Label: "renamed"},
		RenameWorkspaceCommand{WorkspaceID: "w1", Label: "renamed"},
		CreateConversationCommand{CWD: "/repo", Label: "new", AgentKind: "codex", AgentName: "codex-test"},
		CreateTabCommand{WorkspaceID: "w1", CWD: "/repo", Label: "two"},
		SplitPaneCommand{WorkspaceID: "w1", TargetPaneID: "w1:p1", Direction: SplitRight},
		PromptAgentCommand{Target: "codex-test", Text: "continue"},
		WorktreeCreateCommand{WorkspaceID: "w1", Branch: "feature", Path: "/repo-feature"},
		WorktreeOpenCommand{WorkspaceID: "w1", Path: "/repo-feature"},
		ResizePaneCommand{PaneID: "w1:p1", Direction: PaneRight},
		SwapPaneCommand{PaneID: "w1:p1", Direction: PaneLeft},
		ZoomPaneCommand{PaneID: "w1:p1", Mode: ZoomToggle},
	}
	for i, command := range commands {
		receipt, err := herdr.Execute(ctx, DefaultSession(), "op-"+string(rune('a'+i)), command)
		if err != nil {
			t.Fatalf("command %T failed: receipt=%+v err=%v", command, receipt, err)
		}
		if receipt.OperationID == "" || (receipt.Outcome != OutcomeApplied && receipt.Outcome != OutcomeNoop) {
			t.Fatalf("command %T receipt=%+v", command, receipt)
		}
	}
	assertSafeHerdrParams(t, log.snapshot())
}

func TestHerdrNotIdleMapsToNotReady(t *testing.T) {
	fault, ok := AsFault(herdrFault("pane.read", "agent_not_idle", "agent is working"))
	if !ok || fault.Code != CodeNotReady {
		t.Fatalf("fault=%+v", fault)
	}
}

func TestHerdrInvalidKeyStaysAKeyError(t *testing.T) {
	fault, ok := AsFault(herdrFault("pane.send_keys", "invalid_key", "unsupported key pageup"))
	if !ok || fault.Code != CodeKey {
		t.Fatalf("fault=%+v", fault)
	}
}

func assertSafeHerdrParams(t *testing.T, requests []scriptedRequest) {
	t.Helper()
	seen := map[string]bool{}
	for _, request := range requests {
		seen[request.Method] = true
		var params map[string]any
		if err := json.Unmarshal(request.Params, &params); err != nil {
			t.Fatal(err)
		}
		switch request.Method {
		case "workspace.create", "tab.create", "pane.split", "worktree.create", "worktree.open":
			if focus, ok := params["focus"].(bool); !ok || focus {
				t.Fatalf("%s did not force focus=false: %s", request.Method, request.Params)
			}
			if _, ok := params["env"]; ok {
				t.Fatalf("%s exposed env: %s", request.Method, request.Params)
			}
		case "agent.start":
			if params["timeout_ms"] != float64(30000) {
				t.Fatalf("agent.start timeout not aligned: %s", request.Params)
			}
			for _, forbidden := range []string{"args", "env", "focus"} {
				if _, ok := params[forbidden]; ok {
					t.Fatalf("agent.start exposed %s: %s", forbidden, request.Params)
				}
			}
		case "agent.prompt":
			if _, ok := params["wait"]; ok {
				t.Fatalf("agent.prompt must not wait: %s", request.Params)
			}
		case "pane.swap":
			if params["pane_id"] != "w1:p1" || params["direction"] != "left" {
				t.Fatalf("pane.swap was not constrained to neighbor direction: %s", request.Params)
			}
			if _, ok := params["target_pane_id"]; ok {
				t.Fatalf("pane.swap exposed exact target: %s", request.Params)
			}
		}
	}
	for _, method := range []string{"workspace.create", "agent.start", "tab.create", "pane.split", "agent.prompt", "worktree.create", "worktree.open", "pane.resize", "pane.swap", "pane.zoom"} {
		if !seen[method] {
			t.Fatalf("method %s was not exercised", method)
		}
	}
}

func TestCreateConversationWithoutAgentKindSkipsAgentStart(t *testing.T) {
	socket, log := startScriptedHerdr(t, standardReply)
	receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "op-terminal", CreateConversationCommand{CWD: "/repo", Label: "shell"})
	if err != nil || receipt.Outcome != OutcomeApplied || len(receipt.Created) != 3 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	var createdWorkspace bool
	for _, request := range log.snapshot() {
		if request.Method == "agent.start" {
			t.Fatal("terminal conversation called agent.start")
		}
		if request.Method == "workspace.create" {
			createdWorkspace = true
		}
	}
	if !createdWorkspace {
		t.Fatal("terminal conversation skipped workspace.create")
	}
}

func TestDescribeWithoutAgentManifestsStillAllowsCreateConversation(t *testing.T) {
	socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		if request.Method == "server.agent_manifests" {
			return scriptedReply{Result: map[string]any{"type": "agent_manifest_status", "manifests": []any{}}}
		}
		return standardReply(request)
	})
	herdr := NewHerdr(socket)
	descriptor, err := herdr.Describe(context.Background(), DefaultSession())
	if err != nil || !descriptor.Supports(FeatureCreateConversation) || len(descriptor.AgentKinds) != 0 {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
	receipt, err := herdr.Execute(context.Background(), DefaultSession(), "op-empty-kinds", CreateConversationCommand{CWD: "/repo"})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
}

func TestCreateConversationCompensatesOnlyDefiniteAgentFailure(t *testing.T) {
	closed := make(chan struct{}, 1)
	socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		switch request.Method {
		case "agent.start":
			return scriptedReply{Error: &scriptedError{Code: "agent_not_ready", Message: "agent not ready"}}
		case "workspace.close":
			closed <- struct{}{}
			return scriptedReply{Result: map[string]any{"type": "ok"}}
		default:
			return standardReply(request)
		}
	})
	receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "op-compensate", CreateConversationCommand{CWD: "/repo", AgentKind: "codex"})
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeNotReady || receipt.Outcome != OutcomeNotApplied || len(receipt.Removed) != 3 {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
	select {
	case <-closed:
	default:
		t.Fatal("definite agent failure was not compensated")
	}
}

func TestCreateConversationTimeoutIsUnknownAndNeverCompensated(t *testing.T) {
	var closed bool
	var mu sync.Mutex
	socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		switch request.Method {
		case "agent.start":
			return scriptedReply{Result: map[string]any{"type": "agent_started", "agent": map[string]any{"pane_id": "w2:p1"}, "argv": []string{"codex"}}, Delay: 100 * time.Millisecond}
		case "workspace.close":
			mu.Lock()
			closed = true
			mu.Unlock()
			return scriptedReply{Result: map[string]any{"type": "ok"}}
		default:
			return standardReply(request)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	receipt, err := NewHerdr(socket).Execute(ctx, DefaultSession(), "op-timeout", CreateConversationCommand{CWD: "/repo", AgentKind: "codex"})
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeTimeout || fault.Outcome != OutcomeUnknown || receipt.Outcome != OutcomeUnknown || len(receipt.Created) != 3 {
		t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
	}
	time.Sleep(120 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if closed {
		t.Fatal("ambiguous agent.start was compensated")
	}
}

func TestHerdrRejectsMalformedEnvelope(t *testing.T) {
	socket, _ := startScriptedHerdr(t, func(scriptedRequest) scriptedReply {
		return scriptedReply{Result: nil}
	})
	_, err := NewHerdr(socket).Observe(context.Background(), DefaultSession(), SnapshotQuery{})
	if err == nil {
		t.Fatal("malformed Herdr response accepted")
	}
}

func TestProtocol18RejectsExtendedCallsBeforeWritingHerdr(t *testing.T) {
	socket, log := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		if request.Method == "session.snapshot" {
			return scriptedReply{Result: map[string]any{
				"type": "session_snapshot",
				"snapshot": map[string]any{
					"version": "0.7.0", "protocol": 18,
					"workspaces": []any{}, "tabs": []any{}, "panes": []any{},
				},
			}}
		}
		return standardReply(request)
	})
	herdr := NewHerdr(socket)
	commands := []Command{
		CreateConversationCommand{CWD: "/repo", AgentKind: "codex"},
		CreateTabCommand{WorkspaceID: "w1"}, SplitPaneCommand{TargetPaneID: "w1:p1", Direction: SplitRight},
		PromptAgentCommand{Target: "codex", Text: "go"}, WorktreeCreateCommand{WorkspaceID: "w1"},
		WorktreeOpenCommand{WorkspaceID: "w1", Path: "/repo-feature"}, ResizePaneCommand{PaneID: "w1:p1", Direction: PaneRight},
		SwapPaneCommand{PaneID: "w1:p1", Direction: PaneLeft}, ZoomPaneCommand{PaneID: "w1:p1", Mode: ZoomToggle},
	}
	for i, command := range commands {
		receipt, err := herdr.Execute(context.Background(), DefaultSession(), "op-proto18-"+string(rune('a'+i)), command)
		fault, ok := AsFault(err)
		if !ok || fault.Code != CodeUnsupported || receipt.Outcome != OutcomeNotApplied {
			t.Fatalf("command %T receipt=%+v fault=%+v err=%v", command, receipt, fault, err)
		}
	}
	if _, err := herdr.Observe(context.Background(), DefaultSession(), WorktreeListQuery{WorkspaceID: "w1"}); err == nil {
		t.Fatal("protocol 18 worktree list was accepted")
	}
	for _, request := range log.snapshot() {
		switch request.Method {
		case "session.snapshot", "server.agent_manifests":
		default:
			t.Fatalf("unsupported protocol emitted %s", request.Method)
		}
	}
}

func TestWorktreeMutationRejectsIncompleteSuccess(t *testing.T) {
	for _, tc := range []struct {
		name    string
		command Command
		result  map[string]any
	}{
		{
			name: "create missing tab pane and path", command: WorktreeCreateCommand{WorkspaceID: "w1"},
			result: map[string]any{"type": "worktree_created", "workspace": map[string]any{"workspace_id": "w2"}},
		},
		{
			name: "open missing path", command: WorktreeOpenCommand{WorkspaceID: "w1", Branch: "feature"},
			result: map[string]any{"type": "worktree_opened", "workspace": map[string]any{"workspace_id": "w2"}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
				if request.Method == "worktree.create" || request.Method == "worktree.open" {
					return scriptedReply{Result: tc.result}
				}
				return standardReply(request)
			})
			receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "op_AAECAwQFBgcICQoL", tc.command)
			fault, ok := AsFault(err)
			if !ok || fault.Code != CodeInternal || fault.Outcome != OutcomeUnknown || receipt.Outcome != OutcomeUnknown {
				t.Fatalf("receipt=%+v fault=%+v err=%v", receipt, fault, err)
			}
		})
	}
}

func TestOpenExplicitFakeNeverDialsHerdr(t *testing.T) {
	t.Setenv("HERDR_SOCKET_PATH", filepath.Join(t.TempDir(), "would-be-real.sock"))
	runtime, source, err := Open(true, false)
	if err != nil || !strings.HasPrefix(source, "fake:explicit-dev") {
		t.Fatalf("runtime=%T source=%q err=%v", runtime, source, err)
	}
	if _, ok := runtime.(*Fake); !ok {
		t.Fatalf("explicit fake returned %T", runtime)
	}
}

func TestOpenHerdrRecoversWhenSocketAppearsLater(t *testing.T) {
	socket := shortTestSocket(t)
	t.Setenv("HERDR_SOCKET_PATH", socket)
	rt, source, err := Open(false, false)
	if err != nil || source != "herdr:"+socket {
		t.Fatalf("runtime=%T source=%q err=%v", rt, source, err)
	}
	if _, ok := rt.(*Herdr); !ok {
		t.Fatalf("configured runtime = %T, want *Herdr", rt)
	}
	if _, err := rt.Describe(context.Background(), DefaultSession()); err == nil {
		t.Fatal("missing Herdr socket reported online")
	}
	startScriptedHerdrAt(t, socket, standardReply)
	descriptor, err := rt.Describe(context.Background(), DefaultSession())
	if err != nil || descriptor.Runtime != "herdr" || descriptor.Protocol != 19 {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
}

func TestNamedSessionCannotEscapeConfigRoot(t *testing.T) {
	herdr := NewHerdr(filepath.Join(t.TempDir(), "default.sock"))
	herdr.Multi = true
	for _, name := range []string{"../escape", ".", "" + strings.Repeat("a", 129)} {
		if _, err := herdr.socketFor(NamedSession(name)); err == nil {
			t.Fatalf("accepted session %q", name)
		}
	}
	if _, err := os.Stat(herdr.ConfigRoot); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestHerdrSendKeysRewritesBrowserArrows(t *testing.T) {
	socket, log := startScriptedHerdr(t, standardReply)
	herdr := NewHerdr(socket)
	if _, err := herdr.Execute(context.Background(), DefaultSession(), "op-arrows", SendKeysCommand{
		PaneID: "w1:p1", Keys: []string{"ArrowUp", "ArrowDown"},
	}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, request := range log.snapshot() {
		if request.Method != "pane.send_keys" {
			continue
		}
		var params struct {
			Keys []string `json:"keys"`
		}
		if json.Unmarshal(request.Params, &params) != nil {
			t.Fatalf("params: %s", request.Params)
		}
		if len(params.Keys) == 2 && params.Keys[0] == "up" && params.Keys[1] == "down" {
			found = true
		}
	}
	if !found {
		t.Fatal("ArrowUp/ArrowDown were not rewritten to Herdr up/down")
	}
}
