package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"pairfob/internal/envelope"
	"pairfob/internal/journal"
	"pairfob/internal/mux"
	"pairfob/internal/phone"
	"pairfob/internal/runtime"
)

func runtimeRPCClient(t *testing.T, rt runtime.Runtime) (*Engine, *phone.Client) {
	t.Helper()
	hub := mux.NewHub("pf_runtime_rpc")
	engineSide, hubDaemon := mux.NewPipePair(128)
	engine := NewEngine(hub, engineSide, rt)
	stopDaemon := pump(t, hubDaemon, func(frame envelope.Frame) { hub.HandleDaemon(hubDaemon, frame) })
	t.Cleanup(func() { close(stopDaemon) })
	if err := engine.Register("pf_runtime_rpc"); err != nil {
		t.Fatal(err)
	}
	stopEngine := make(chan struct{})
	go engine.RecvLoop(stopEngine)
	t.Cleanup(func() { close(stopEngine) })

	psk := make([]byte, 32)
	_, _ = rand.Read(psk)
	deviceID := "dev_" + hex.EncodeToString(psk[:8])
	engine.PutDevice(deviceID, psk)
	clientSide, hubClient := mux.NewPipePair(128)
	stopClient := pump(t, hubClient, func(frame envelope.Frame) { hub.HandleClient(hubClient, frame) })
	t.Cleanup(func() { close(stopClient) })
	client := &phone.Client{Conn: clientSide, DeviceID: deviceID, PSK: psk, DaemonPK: engine.PK}
	if err := client.Resume(engine.DaemonID); err != nil {
		t.Fatal(err)
	}
	return engine, client
}

type recoveringTestRuntime struct {
	runtime.Runtime
	online bool
}

func (r *recoveringTestRuntime) Describe(ctx context.Context, session runtime.SessionRef) (runtime.Descriptor, error) {
	if !r.online {
		return runtime.Descriptor{}, &runtime.Fault{
			Code: runtime.CodeOffline, Outcome: runtime.OutcomeNotApplied,
			Retry: runtime.RetryReadSafe, SafeMessage: "Herdr is offline",
		}
	}
	descriptor, err := r.Runtime.Describe(ctx, session)
	descriptor.Runtime = "herdr"
	return descriptor, err
}

func decodeResult(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestRuntimeRPCNewOperationsAndDeduplication(t *testing.T) {
	fake := runtime.NewFake()
	_, client := runtimeRPCClient(t, fake)

	configRaw, err := client.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	config := decodeResult(t, configRaw)
	if config["runtime"] != "fake" || len(config["agent_kinds"].([]any)) == 0 {
		t.Fatalf("unexpected config: %s", configRaw)
	}
	capabilities, ok := config["capabilities"].(map[string]any)
	if !ok || len(capabilities) != 11 || capabilities["create_conversation"] != true || capabilities["zoom_pane"] != true || capabilities["worktrees"] != nil || capabilities["layout"] != nil {
		t.Fatalf("unexpected capability contract: %s", configRaw)
	}

	createParams := map[string]any{
		"operation_id": "op_AAECAwQFBgcICQoL", "cwd": "/tmp/pairfob", "agent_kind": "codex", "label": "web",
	}
	createdRaw, err := client.RPC("CreateConversation", createParams)
	if err != nil {
		t.Fatal(err)
	}
	created := decodeResult(t, createdRaw)
	for _, key := range []string{"workspace_id", "tab_id", "pane_id", "agent_kind", "operation_id", "outcome"} {
		if created[key] == nil || created[key] == "" {
			t.Fatalf("CreateConversation missing %s: %s", key, createdRaw)
		}
	}
	replayedRaw, err := client.RPC("CreateConversation", createParams)
	if err != nil || string(replayedRaw) != string(createdRaw) {
		t.Fatalf("deduplicated replay changed result: first=%s second=%s err=%v", createdRaw, replayedRaw, err)
	}
	conflictParams := map[string]any{
		"operation_id": createParams["operation_id"], "cwd": "/tmp/pairfob", "agent_kind": "claude", "label": "different",
	}
	if _, err := client.RPC("CreateConversation", conflictParams); err == nil || err.Error() != "conflict" {
		t.Fatalf("operation id reuse was not rejected: %v", err)
	}

	terminalRaw, err := client.RPC("CreateConversation", map[string]any{
		"operation_id": "op_terminalpane0001", "cwd": "/tmp/pairfob", "label": "shell",
	})
	if err != nil {
		t.Fatal(err)
	}
	terminal := decodeResult(t, terminalRaw)
	if _, ok := terminal["agent_kind"]; ok {
		t.Fatalf("terminal CreateConversation leaked agent_kind: %s", terminalRaw)
	}
	for _, key := range []string{"workspace_id", "tab_id", "pane_id", "operation_id", "outcome"} {
		if terminal[key] == nil || terminal[key] == "" {
			t.Fatalf("terminal CreateConversation missing %s: %s", key, terminalRaw)
		}
	}

	workspaceID := created["workspace_id"].(string)
	paneID := created["pane_id"].(string)
	tabRaw, err := client.RPC("CreateTab", map[string]any{
		"operation_id": "op_AQECAwQFBgcICQoL", "workspace_id": workspaceID, "cwd": "/tmp/pairfob", "label": "tests",
	})
	if err != nil || decodeResult(t, tabRaw)["pane_id"] == "" {
		t.Fatalf("CreateTab result=%s err=%v", tabRaw, err)
	}
	if _, ok := decodeResult(t, tabRaw)["agent_kind"]; ok {
		t.Fatalf("terminal CreateTab leaked agent_kind: %s", tabRaw)
	}
	if _, err := client.RPC("CreateTab", map[string]any{
		"operation_id": "op_tabagent00000001", "workspace_id": workspaceID, "cwd": "/tmp/pairfob", "agent_kind": "not a kind",
	}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("CreateTab accepted an invalid agent kind: %v", err)
	}
	splitRaw, err := client.RPC("SplitPane", map[string]any{
		"operation_id": "op_AgECAwQFBgcICQoL", "pane_id": paneID, "direction": "right", "ratio": 0.5,
	})
	if err != nil || decodeResult(t, splitRaw)["pane_id"] == "" {
		t.Fatalf("SplitPane result=%s err=%v", splitRaw, err)
	}
	if _, ok := decodeResult(t, splitRaw)["agent_kind"]; ok {
		t.Fatalf("terminal SplitPane leaked agent_kind: %s", splitRaw)
	}
	if _, err := client.RPC("SplitPane", map[string]any{
		"operation_id": "op_splitagent000001", "pane_id": paneID, "direction": "down", "agent_kind": "not a kind",
	}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("SplitPane accepted an invalid agent kind: %v", err)
	}
	if _, err := client.RPC("PromptAgent", map[string]any{
		"operation_id": "op_AwECAwQFBgcICQoL", "pane_id": paneID, "text": "review the diff",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("PromptAgent", map[string]any{
		"operation_id": "op_multibyte_prompt_0001", "pane_id": paneID, "text": strings.Repeat("会", maxTextBytes/3+1),
	}); err == nil || err.Error() != "too_large" {
		t.Fatalf("multibyte prompt must use the 32 KiB wire budget: %v", err)
	}
	for index, request := range []struct {
		op     string
		params map[string]any
	}{
		{"ResizePane", map[string]any{"operation_id": "op_BAECAwQFBgcICQoL", "pane_id": paneID, "direction": "right", "amount": 0.1}},
		{"SwapPane", map[string]any{"operation_id": "op_BQECAwQFBgcICQoL", "pane_id": paneID, "direction": "down"}},
		{"ZoomPane", map[string]any{"operation_id": "op_BgECAwQFBgcICQoL", "pane_id": paneID, "mode": "on"}},
	} {
		if _, err := client.RPC(request.op, request.params); err != nil {
			t.Fatalf("layout request %d %s: %v", index, request.op, err)
		}
	}

	worktreeRaw, err := client.RPC("CreateWorktree", map[string]any{
		"operation_id": "op_BwECAwQFBgcICQoL", "workspace_id": "w0", "branch": "feature/web",
	})
	if err != nil {
		t.Fatal(err)
	}
	worktree := decodeResult(t, worktreeRaw)
	if worktree["workspace_id"] == "" || worktree["path"] == "" {
		t.Fatalf("bad worktree result: %s", worktreeRaw)
	}
	listRaw, err := client.RPC("ListWorktrees", map[string]any{"workspace_id": "w0"})
	if err != nil || !json.Valid(listRaw) || !containsJSONText(listRaw, "feature/web") {
		t.Fatalf("ListWorktrees result=%s err=%v", listRaw, err)
	}
	openedRaw, err := client.RPC("OpenWorktree", map[string]any{
		"operation_id": "op_CAECAwQFBgcICQoL", "workspace_id": "w0", "path": worktree["path"],
	})
	if err != nil {
		t.Fatalf("OpenWorktree failed: %v create=%s list=%s", err, worktreeRaw, listRaw)
	}
	opened := decodeResult(t, openedRaw)
	if opened["outcome"] != "noop" || opened["workspace_id"] == "" || opened["path"] == "" {
		t.Fatalf("OpenWorktree result=%s err=%v", openedRaw, err)
	}
	// The UI follows a successful create into the worktree workspace. Opening
	// the same branch from that new workspace must still resolve to the trusted
	// list entry and remain idempotent.
	reopenedRaw, err := client.RPC("OpenWorktree", map[string]any{
		"operation_id": "op_CQECAwQFBgcICQoL", "workspace_id": worktree["workspace_id"], "branch": "feature/web",
	})
	if err != nil {
		t.Fatalf("OpenWorktree by branch from created workspace failed: %v create=%s", err, worktreeRaw)
	}
	reopened := decodeResult(t, reopenedRaw)
	if reopened["outcome"] != "noop" || reopened["workspace_id"] != worktree["workspace_id"] || reopened["branch"] != "feature/web" {
		t.Fatalf("OpenWorktree branch result=%s err=%v", reopenedRaw, err)
	}
}

func TestGetConfigTracksRecoveringRuntimeAvailability(t *testing.T) {
	rt := &recoveringTestRuntime{Runtime: runtime.NewFake()}
	_, client := runtimeRPCClient(t, rt)

	offlineRaw, err := client.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	offline := decodeResult(t, offlineRaw)
	offlineCapabilities := offline["capabilities"].(map[string]any)
	if offline["runtime"] != "offline" || len(offlineCapabilities) != 11 {
		t.Fatalf("offline config did not fail closed: %s", offlineRaw)
	}
	for capability, available := range offlineCapabilities {
		if available != false {
			t.Fatalf("offline capability %s remained available: %s", capability, offlineRaw)
		}
	}

	rt.online = true
	onlineRaw, err := client.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	online := decodeResult(t, onlineRaw)
	onlineCapabilities := online["capabilities"].(map[string]any)
	if online["runtime"] != "herdr" || onlineCapabilities["create_conversation"] != true {
		t.Fatalf("recovered config stayed offline: %s", onlineRaw)
	}
}

func TestLiveRuntimeKindOnlyMapsAvailabilityFailuresOffline(t *testing.T) {
	tests := []struct {
		name       string
		descriptor runtime.Descriptor
		err        error
		want       string
	}{
		{name: "live descriptor", descriptor: runtime.Descriptor{Runtime: "herdr"}, want: "herdr"},
		{name: "offline fault", err: &runtime.Fault{Code: runtime.CodeOffline}, want: "offline"},
		{name: "timeout fault", err: &runtime.Fault{Code: runtime.CodeTimeout}, want: "offline"},
		{name: "context deadline", err: context.DeadlineExceeded, want: "offline"},
		{name: "invalid response", err: &runtime.Fault{Code: runtime.CodeInternal}, want: "herdr"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := liveRuntimeKind("herdr", test.descriptor, test.err); got != test.want {
				t.Fatalf("kind=%q, want %q", got, test.want)
			}
		})
	}
}

func TestMutationIDsBindCompleteIntentAndSession(t *testing.T) {
	_, client := runtimeRPCClient(t, runtime.NewFake())
	if _, err := client.RPC("RenameTab", map[string]any{"tab_id": "w0:t1", "label": "missing id"}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("missing operation_id was not rejected: %v", err)
	}
	operationID := "op_DAECAwQFBgcICQoL"
	base := map[string]any{"operation_id": operationID, "pane_id": "w0:p1", "text": "hello", "submit": false}
	if _, err := client.RPC("SendText", base); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("SendText", map[string]any{"operation_id": operationID, "pane_id": "w0:p1", "text": "hello", "submit": true}); err == nil || err.Error() != "conflict" {
		t.Fatalf("same id with changed submit intent was not rejected: %v", err)
	}
	sessionOperationID := "op_DQECAwQFBgcICQoL"
	if _, err := client.RPC("RenamePane", map[string]any{"operation_id": sessionOperationID, "session": "alpha", "pane_id": "w0:p1", "label": "named"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("RenamePane", map[string]any{"operation_id": sessionOperationID, "session": "beta", "pane_id": "w0:p1", "label": "named"}); err == nil || err.Error() != "conflict" {
		t.Fatalf("same id crossed named sessions: %v", err)
	}
}

func TestOpenWorktreeResolvesBranchButRejectsOutsideAuthority(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	fake := runtime.NewFake()
	fake.Snap.Workspaces[0].Cwd = workspace
	branch := "outside"
	fake.Worktrees = []runtime.Worktree{{Path: outside, Branch: &branch, Linked: true}}
	_, client := runtimeRPCClient(t, fake)
	_, err := client.RPC("OpenWorktree", map[string]any{
		"operation_id": "op_DgECAwQFBgcICQoL", "workspace_id": "w0", "branch": branch,
	})
	if err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("outside branch was not rejected: %v", err)
	}
	if fake.Worktrees[0].OpenWorkspaceID != nil {
		t.Fatal("outside worktree reached the runtime mutation")
	}
}

func containsJSONText(raw []byte, wanted string) bool {
	return json.Valid(raw) && wanted != "" && strings.Contains(string(raw), wanted)
}

func TestHistoryUsesTrustedPaneBindingAndHidesItFromSnapshot(t *testing.T) {
	root := t.TempDir()
	sessionID := "session_12345678"
	transcript := filepath.Join(root, "sessions", "2026", "08", "25", "rollout-"+sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"trusted history"}]}}` + "\n" +
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"next page"}]}}` + "\n"
	if err := os.WriteFile(transcript, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := runtime.NewFake()
	fake.Snap.Panes[0].Agent = "codex"
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: sessionID}
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = &journal.Reader{CodexRoot: root}

	snapshot, err := client.RPC("Snapshot", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !containsJSONText(snapshot, `"history_available":true`) || containsJSONText(snapshot, sessionID) || containsJSONText(snapshot, "agent_session") {
		t.Fatalf("snapshot leaked or hid the wrong fields: %s", snapshot)
	}
	history, err := client.RPC("History", map[string]any{"pane_id": "w0:p1", "limit": 20})
	if err != nil || !containsJSONText(history, "trusted history") {
		t.Fatalf("History result=%s err=%v", history, err)
	}
	firstPage, err := client.RPC("History", map[string]any{"pane_id": "w0:p1", "limit": 1})
	if err != nil {
		t.Fatal(err)
	}
	var page map[string]any
	if json.Unmarshal(firstPage, &page) != nil || page["next_cursor"] == nil {
		t.Fatalf("missing cursor: %s", firstPage)
	}
	otherID := "session_87654321"
	otherTranscript := filepath.Join(root, "sessions", "2026", "08", "25", "rollout-"+otherID+".jsonl")
	if err := os.WriteFile(otherTranscript, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: otherID}
	if _, err := client.RPC("History", map[string]any{"pane_id": "w0:p1", "cursor": page["next_cursor"], "limit": 1}); err == nil || err.Error() != "conflict" {
		t.Fatalf("cursor crossed trusted binding: %v", err)
	}
}

func TestTerminalHistoryUsesBoundedOpaqueCursorWithoutTranscript(t *testing.T) {
	fake := runtime.NewFake()
	rows := make([]string, 0, 260)
	for i := range 260 {
		rows = append(rows, "row-"+strconv.Itoa(i))
	}
	fake.Panes["w0:p1"].Text = strings.Join(rows, "\n") + "\n"
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = nil
	configRaw, err := client.RPC("GetConfig", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	config := decodeResult(t, configRaw)
	capabilities := config["capabilities"].(map[string]any)
	if capabilities["history"] != true {
		t.Fatalf("terminal fallback did not advertise History: %s", configRaw)
	}

	raw, err := client.RPC("History", map[string]any{"pane_id": "w0:p1", "cursor": "term:v1:200", "limit": 50})
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, raw)
	items, ok := result["items"].([]any)
	if !ok || len(items) != 1 || result["next_cursor"] != "term:v1:400" || result["truncated"] != true {
		t.Fatalf("unexpected terminal page: %s", raw)
	}
	item := items[0].(map[string]any)
	text := item["text"].(string)
	if strings.Contains(text, "row-0\n") || !strings.Contains(text, "row-60\n") || !strings.Contains(text, "row-259\n") {
		t.Fatalf("terminal history was not the bounded tail: %q", text)
	}
	if _, err := client.RPC("History", map[string]any{"pane_id": "w0:p1", "cursor": "term:v1:201", "limit": 50}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("arbitrary terminal line count accepted: %v", err)
	}
	if _, err := client.RPC("PaneRead", map[string]any{"pane_id": "w0:p1", "source": "recent_unwrapped", "format": "text", "lines": 200}); err == nil || err.Error() != "forbidden" {
		t.Fatalf("public PaneRead escaped the visible-only boundary: %v", err)
	}
}
