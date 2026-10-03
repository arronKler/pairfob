package testvec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"testing"
)

type schemaNode struct {
	Ref                  string                `json:"$ref"`
	Const                any                   `json:"const"`
	Enum                 []string              `json:"enum"`
	Required             []string              `json:"required"`
	Properties           map[string]schemaNode `json:"properties"`
	Items                *schemaNode           `json:"items"`
	AllOf                []schemaNode          `json:"allOf"`
	OneOf                []schemaNode          `json:"oneOf"`
	If                   *schemaNode           `json:"if"`
	Then                 *schemaNode           `json:"then"`
	AdditionalProperties *bool                 `json:"additionalProperties"`
	MaxLength            int                   `json:"maxLength"`
	MinLength            int                   `json:"minLength"`
}

func sortedPropertyNames(properties map[string]schemaNode) []string {
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func requireExactObjectFields(t *testing.T, defs map[string]schemaNode, name string, fields, required []string) {
	t.Helper()
	node, ok := defs[name]
	if !ok {
		t.Fatalf("missing $defs.%s", name)
	}
	want := slices.Clone(fields)
	sort.Strings(want)
	if got := sortedPropertyNames(node.Properties); !slices.Equal(got, want) {
		t.Fatalf("$defs.%s fields\n got: %q\nwant: %q", name, got, want)
	}
	wantRequired := slices.Clone(required)
	sort.Strings(wantRequired)
	gotRequired := slices.Clone(node.Required)
	sort.Strings(gotRequired)
	if !slices.Equal(gotRequired, wantRequired) {
		t.Fatalf("$defs.%s required fields\n got: %q\nwant: %q", name, gotRequired, wantRequired)
	}
	if node.AdditionalProperties == nil || *node.AdditionalProperties {
		t.Fatalf("$defs.%s must reject additional properties", name)
	}
}

func requireExactObject(t *testing.T, defs map[string]schemaNode, name string, fields []string) {
	t.Helper()
	requireExactObjectFields(t, defs, name, fields, fields)
}

func TestRPCSchemaListsExactSurface(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate test file")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "proto", "rpc.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs map[string]schemaNode `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	wantOps := []string{
		"Ping", "GetConfig", "DaemonUpdateStatus", "DaemonUpdate", "AgentQuota", "AgentInspect", "Snapshot", "PaneRead", "SendText", "SendKeys",
		"PushSubscribe", "RevokeDevice", "ListDevices", "ListSessions", "History", "AgentTrace", "AgentTraceSummary", "AgentTraceDetail", "RenamePane",
		"RenameTab", "RenameWorkspace", "ClosePane", "CloseTab", "CloseWorkspace",
		"CreateConversation", "CreateTab", "SplitPane", "PromptAgent", "ListWorktrees",
		"WorkspaceOpen", "WorkspaceList", "WorkspaceRead", "WorkspaceMediaOpen", "WorkspaceMediaRead", "WorkspaceMediaClose", "WorkspaceUploadBegin", "WorkspaceUploadWrite", "WorkspaceUploadStatus", "WorkspaceUploadCommit", "WorkspaceUploadCancel", "WorkspaceUploadBeginV2", "WorkspaceUploadWriteV2", "WorkspaceUploadStatusV2", "WorkspaceUploadCommitV2", "WorkspaceUploadCancelV2", "WorkspaceRename", "WorkspaceDelete", "GitStatus", "GitDiff", "GitBranches",
		"CreateWorktree", "OpenWorktree", "ResizePane", "SwapPane", "ZoomPane",
		"TerminalOpen", "TerminalInput", "TerminalResize", "TerminalScroll", "TerminalClose",
		"TransportOffer", "TransportCommit", "TransportRestart",
		"ListMachines", "LinkMachine", "LinkMachineStatus", "LinkMachineCancel",
	}
	if got := schema.Defs["request"].Properties["op"].Enum; !slices.Equal(got, wantOps) {
		t.Fatalf("RPC op surface\n got: %q\nwant: %q", got, wantOps)
	}

	wantErrors := []string{
		"unpaired", "revoked", "pane_not_found", "tab_not_found", "workspace_not_found",
		"stale_prompt", "invalid_key", "herdr_offline", "too_large", "rate_limited",
		"unknown_op", "backpressure", "bad_token", "bad_frame", "internal", "pair_busy",
		"unbound", "wrong_ws", "too_many_devices", "kicked", "daemon_offline", "replay",
		"sas_required", "fp_mismatch", "forbidden", "invalid_argument", "unsupported",
		"agent_not_found", "worktree_not_found", "transcript_unavailable", "unknown_outcome",
		"partial_failure", "conflict",
	}
	if got := schema.Defs["response"].Properties["error"].Properties["code"].Enum; !slices.Equal(got, wantErrors) {
		t.Fatalf("RPC error surface\n got: %q\nwant: %q", got, wantErrors)
	}

	paramsByOp := map[string]schemaNode{}
	for _, clause := range schema.Defs["request"].AllOf {
		if clause.If == nil || clause.Then == nil {
			continue
		}
		op, _ := clause.If.Properties["op"].Const.(string)
		if op != "" {
			paramsByOp[op] = clause.Then.Properties["params"]
		}
	}
	for _, op := range []string{
		"SendText", "SendKeys", "PushSubscribe", "RevokeDevice", "RenamePane", "RenameTab",
		"RenameWorkspace", "ClosePane", "CloseTab", "CloseWorkspace", "CreateConversation", "CreateTab", "SplitPane",
		"PromptAgent", "CreateWorktree", "OpenWorktree", "ResizePane", "SwapPane", "ZoomPane", "WorkspaceRename", "WorkspaceDelete",
		"TerminalOpen", "TerminalInput", "TerminalResize", "TerminalScroll", "TerminalClose",
		"LinkMachine", "LinkMachineCancel",
	} {
		if !slices.Contains(paramsByOp[op].Required, "operation_id") {
			t.Errorf("mutation %s does not require operation_id", op)
		}
	}
	createConversation := paramsByOp["CreateConversation"]
	createRequired := slices.Clone(createConversation.Required)
	sort.Strings(createRequired)
	if !slices.Equal(createRequired, []string{"cwd", "operation_id"}) {
		t.Errorf("CreateConversation required params = %q, want [cwd operation_id]", createRequired)
	}
	if _, ok := createConversation.Properties["agent_kind"]; !ok {
		t.Error("CreateConversation must still allow optional agent_kind")
	}
	for _, op := range []string{"CreateTab", "SplitPane"} {
		params := paramsByOp[op]
		if _, ok := params.Properties["agent_kind"]; !ok || slices.Contains(params.Required, "agent_kind") {
			t.Errorf("%s must allow optional agent_kind", op)
		}
		if params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s params must reject additional properties", op)
		}
	}
	listWorktrees := paramsByOp["ListWorktrees"]
	if got, want := sortedPropertyNames(listWorktrees.Properties), []string{"cwd", "session", "workspace_id"}; !slices.Equal(got, want) {
		t.Errorf("ListWorktrees params fields = %q, want %q", got, want)
	}
	if listWorktrees.AdditionalProperties == nil || *listWorktrees.AdditionalProperties {
		t.Error("ListWorktrees params must reject additional properties")
	}
	if len(listWorktrees.OneOf) != 2 ||
		!slices.Equal(listWorktrees.OneOf[0].Required, []string{"workspace_id"}) ||
		!slices.Equal(listWorktrees.OneOf[1].Required, []string{"cwd"}) {
		t.Errorf("ListWorktrees must require exactly one explicit scope, got oneOf=%v", listWorktrees.OneOf)
	}
	for _, op := range []string{"WorkspaceOpen", "GitStatus", "GitBranches"} {
		params := paramsByOp[op]
		if got, want := sortedPropertyNames(params.Properties), []string{"pane_id", "session"}; !slices.Equal(got, want) || !slices.Equal(params.Required, []string{"pane_id"}) {
			t.Errorf("%s params fields=%q required=%q", op, got, params.Required)
		}
		if params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s params must reject additional properties", op)
		}
	}
	mediaOpen := paramsByOp["WorkspaceMediaOpen"]
	if got, want := sortedPropertyNames(mediaOpen.Properties), []string{"pane_id", "path", "session"}; !slices.Equal(got, want) || !slices.Equal(mediaOpen.Required, []string{"pane_id", "path"}) {
		t.Errorf("WorkspaceMediaOpen params fields=%q required=%q", got, mediaOpen.Required)
	}
	if mediaOpen.AdditionalProperties == nil || *mediaOpen.AdditionalProperties {
		t.Error("WorkspaceMediaOpen params must reject additional properties")
	}
	mediaRead := paramsByOp["WorkspaceMediaRead"]
	if got, want := sortedPropertyNames(mediaRead.Properties), []string{"handle", "length", "offset"}; !slices.Equal(got, want) {
		t.Errorf("WorkspaceMediaRead params fields=%q", got)
	}
	mediaReadRequired := slices.Clone(mediaRead.Required)
	sort.Strings(mediaReadRequired)
	if !slices.Equal(mediaReadRequired, []string{"handle", "length", "offset"}) || mediaRead.AdditionalProperties == nil || *mediaRead.AdditionalProperties {
		t.Errorf("WorkspaceMediaRead required=%q additional=%v", mediaReadRequired, mediaRead.AdditionalProperties)
	}
	mediaClose := paramsByOp["WorkspaceMediaClose"]
	if got, want := sortedPropertyNames(mediaClose.Properties), []string{"handle"}; !slices.Equal(got, want) || !slices.Equal(mediaClose.Required, []string{"handle"}) {
		t.Errorf("WorkspaceMediaClose params fields=%q required=%q", got, mediaClose.Required)
	}
	if mediaClose.AdditionalProperties == nil || *mediaClose.AdditionalProperties {
		t.Error("WorkspaceMediaClose params must reject additional properties")
	}
	for op, required := range map[string][]string{
		"WorkspaceList":   {"pane_id"},
		"WorkspaceRead":   {"pane_id", "path"},
		"WorkspaceRename": {"operation_id", "pane_id", "root", "path", "new_name", "size", "modified_ms", "revision"},
		"WorkspaceDelete": {"operation_id", "pane_id", "root", "path", "size", "modified_ms", "revision"},
		"GitDiff":         {"pane_id", "path", "layer"},
	} {
		params := paramsByOp[op]
		gotRequired := slices.Clone(params.Required)
		sort.Strings(gotRequired)
		sort.Strings(required)
		if !slices.Equal(gotRequired, required) {
			t.Errorf("%s required params=%q, want %q", op, gotRequired, required)
		}
		if params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s params must reject additional properties", op)
		}
	}
	for _, op := range []string{"AgentTrace", "AgentTraceSummary"} {
		params := paramsByOp[op]
		if got, want := sortedPropertyNames(params.Properties), []string{"cursor", "limit", "markers", "pane_id", "session"}; !slices.Equal(got, want) || !slices.Equal(params.Required, []string{"pane_id"}) {
			t.Errorf("%s params fields=%q required=%q", op, got, params.Required)
		}
		if params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s params must reject additional properties", op)
		}
	}
	detailParams := paramsByOp["AgentTraceDetail"]
	if got, want := sortedPropertyNames(detailParams.Properties), []string{"detail_ref", "pane_id", "session"}; !slices.Equal(got, want) {
		t.Errorf("AgentTraceDetail params fields=%q, want %q", got, want)
	}
	detailRequired := slices.Clone(detailParams.Required)
	sort.Strings(detailRequired)
	if !slices.Equal(detailRequired, []string{"detail_ref", "pane_id"}) || detailParams.AdditionalProperties == nil || *detailParams.AdditionalProperties {
		t.Errorf("AgentTraceDetail params required=%q additionalProperties=%v", detailRequired, detailParams.AdditionalProperties)
	}
	for op, fields := range map[string][]string{
		"TransportOffer":   {"attempt_id", "sdp"},
		"TransportCommit":  {"attempt_id", "route_id"},
		"TransportRestart": {"attempt_id", "sdp"},
	} {
		params := paramsByOp[op]
		wantFields := slices.Clone(fields)
		sort.Strings(wantFields)
		if got := sortedPropertyNames(params.Properties); !slices.Equal(got, wantFields) {
			t.Errorf("%s params fields = %q, want %q", op, got, wantFields)
		}
		gotRequired := slices.Clone(params.Required)
		sort.Strings(gotRequired)
		if !slices.Equal(gotRequired, wantFields) {
			t.Errorf("%s required params = %q, want %q", op, gotRequired, wantFields)
		}
		if params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s params must reject additional properties", op)
		}
	}

	requireExactObjectFields(t, paramsByOp, "AgentInspect", []string{"pane_id", "session"}, []string{"pane_id"})
	requireExactObjectFields(t, schema.Defs, "agentInspectResult", []string{"status", "manifest_source", "manifest_version", "matched_rule", "fallback_reason", "skipped_reason", "warning", "screen_detection_skipped", "rules"}, []string{"status", "screen_detection_skipped", "rules"})
	quotaParams := paramsByOp["AgentQuota"]
	if len(quotaParams.Properties) != 0 || quotaParams.AdditionalProperties == nil || *quotaParams.AdditionalProperties {
		t.Error("AgentQuota must reject all parameters")
	}
	requireExactObject(t, schema.Defs, "agentQuotaResult", []string{"items"})
	requireExactObject(t, schema.Defs, "agentQuotaItem", []string{"provider", "plan", "status", "source", "observed_at", "windows"})
	requireExactObjectFields(t, schema.Defs, "agentQuotaWindow", []string{"name", "used_percent", "window_minutes", "resets_at", "unlimited"}, []string{"name", "used_percent", "window_minutes", "resets_at"})

	capabilities := []string{
		"create_conversation", "create_tab", "split_pane", "prompt_agent", "history",
		"list_worktrees", "create_worktree", "open_worktree", "resize_pane", "swap_pane", "zoom_pane",
	}
	requireExactObjectFields(t, schema.Defs, "capabilities", append(slices.Clone(capabilities), "agent_inspect", "rename_file", "delete_file", "upload_file", "upload_file_v2", "list_sessions", "link_machine", "trace_markers"), capabilities)

	// Machine linking names machines by opaque ID only: no SSH target, host,
	// or path may be added to these objects.
	requireExactObject(t, schema.Defs, "listMachinesResult", []string{"machines"})
	requireExactObjectFields(t, schema.Defs, "machineItem", []string{"id", "label", "state", "daemon_id"}, []string{"id", "label", "state"})
	requireExactObjectFields(t, schema.Defs, "machineLinkResult", []string{"operation_id", "machine_id", "phase", "pair_url", "error"}, []string{"operation_id", "machine_id", "phase"})
	requireExactObjectFields(t, paramsByOp, "LinkMachine", []string{"operation_id", "machine_id", "install"}, []string{"operation_id", "machine_id"})
	requireExactObject(t, paramsByOp, "LinkMachineCancel", []string{"operation_id"})
	for _, op := range []string{"ListMachines", "LinkMachineStatus"} {
		if params := paramsByOp[op]; len(params.Properties) != 0 || params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s must reject all parameters", op)
		}
	}

	// Stage-2 V2 upload surface: the dedicated state def reports the V2 chunk
	// bound, and the V2 write carries the larger base64 payload bound. The
	// legacy def and its 32768/43692 bounds must stay frozen.
	uploadV2 := schema.Defs["workspaceUploadStateV2"]
	if uploadV2.Properties["chunk_bytes"].Const.(float64) != 131072 {
		t.Errorf("workspaceUploadStateV2 chunk_bytes = %v, want 131072", uploadV2.Properties["chunk_bytes"].Const)
	}
	if uploadV2.AdditionalProperties == nil || *uploadV2.AdditionalProperties {
		t.Error("workspaceUploadStateV2 must reject additional properties")
	}
	uploadV1 := schema.Defs["workspaceUploadState"]
	if uploadV1.Properties["chunk_bytes"].Const.(float64) != 32768 {
		t.Errorf("workspaceUploadState chunk_bytes = %v, want frozen 32768", uploadV1.Properties["chunk_bytes"].Const)
	}
	writeV2 := paramsByOp["WorkspaceUploadWriteV2"]
	if got := writeV2.Properties["data_b64"].MaxLength; got != 174764 {
		t.Errorf("WorkspaceUploadWriteV2 data_b64 maxLength = %v, want 174764", got)
	}
	writeV1 := paramsByOp["WorkspaceUploadWrite"]
	if got := writeV1.Properties["data_b64"].MaxLength; got != 43692 {
		t.Errorf("WorkspaceUploadWrite data_b64 maxLength = %v, want frozen 43692", got)
	}
	for _, op := range []string{"WorkspaceUploadBeginV2", "WorkspaceUploadWriteV2", "WorkspaceUploadStatusV2", "WorkspaceUploadCommitV2", "WorkspaceUploadCancelV2"} {
		params := paramsByOp[op]
		if params.AdditionalProperties == nil || *params.AdditionalProperties {
			t.Errorf("%s params must reject additional properties", op)
		}
	}
	requireExactObject(t, schema.Defs, "getConfigResult", []string{
		"protocol", "build", "daemon_id", "hostname", "runtime", "vapid_public", "submit_keys",
		"idle_pause_ms", "push_delivery", "push_enabled", "agent_kinds", "capabilities",
	})
	requireExactObjectFields(t, schema.Defs, "createConversationResult",
		[]string{"operation_id", "workspace_id", "tab_id", "pane_id", "agent_kind", "outcome"},
		[]string{"operation_id", "workspace_id", "tab_id", "pane_id", "outcome"},
	)
	requireExactObject(t, schema.Defs, "createdPaneResult", []string{
		"operation_id", "workspace_id", "tab_id", "pane_id", "outcome",
	})
	requireExactObject(t, schema.Defs, "promptAgentResult", []string{
		"operation_id", "pane_id", "agent_status", "outcome",
	})
	requireExactObject(t, schema.Defs, "historyItem", []string{"role", "text"})
	requireExactObject(t, schema.Defs, "historyResult", []string{"items", "next_cursor", "truncated"})
	requireExactObjectFields(t, schema.Defs, "agentTraceItem",
		[]string{"type", "text", "name", "input", "output"},
		[]string{"type"},
	)
	requireExactObject(t, schema.Defs, "agentTraceResult", []string{"items", "next_cursor", "truncated"})
	requireExactObjectFields(t, schema.Defs, "agentTraceSummaryItem",
		[]string{"type", "text", "name", "state", "detail_ref"},
		[]string{"type"},
	)
	requireExactObject(t, schema.Defs, "agentTraceSummaryResult", []string{"items", "next_cursor", "truncated"})
	requireExactObjectFields(t, schema.Defs, "agentTraceDetailResult",
		[]string{"detail_ref", "text", "input", "output", "truncated"},
		[]string{"detail_ref", "truncated"},
	)
	requireExactObject(t, schema.Defs, "worktreeItem", []string{
		"path", "branch", "label", "is_bare", "is_detached", "is_prunable", "is_linked_worktree", "open_workspace_id",
	})
	requireExactObject(t, schema.Defs, "listWorktreesResult", []string{"worktrees"})
	requireExactObject(t, schema.Defs, "workspaceFeatures", []string{"files", "git_status", "git_diff", "git_branches"})
	requireExactObject(t, schema.Defs, "workspaceRepository", []string{"name", "branch", "head", "detached"})
	requireExactObject(t, schema.Defs, "workspaceOpenResult", []string{"name", "root", "features", "git"})
	requireExactObjectFields(t, schema.Defs, "workspaceEntry", []string{"name", "path", "kind", "size", "modified_ms", "hidden", "revision"}, []string{"name", "path", "kind", "size", "modified_ms", "hidden"})
	requireExactObject(t, schema.Defs, "workspaceListResult", []string{"path", "entries", "next_cursor", "truncated", "revision"})
	requireExactObject(t, schema.Defs, "workspaceMutationResult", []string{"operation_id", "outcome"})
	requireExactObject(t, schema.Defs, "workspaceReadResult", []string{"path", "kind", "size", "modified_ms", "content", "truncated", "revision"})
	requireExactObject(t, schema.Defs, "workspaceMediaOpenResult", []string{
		"handle", "path", "kind", "mime", "size", "modified_ms", "sha256", "expires_ms",
		"chunk_bytes", "max_bytes", "max_pixels", "width", "height",
	})
	requireExactObject(t, schema.Defs, "workspaceMediaReadResult", []string{"handle", "offset", "length", "bytes", "eof"})
	requireExactObject(t, schema.Defs, "workspaceMediaCloseResult", []string{"handle", "closed"})
	requireExactObject(t, schema.Defs, "gitChange", []string{"path", "original_path", "index", "worktree"})
	requireExactObject(t, schema.Defs, "gitStatusResult", []string{"branch", "head", "upstream", "ahead", "behind", "changes", "truncated", "revision"})
	requireExactObject(t, schema.Defs, "gitDiffResult", []string{"path", "layer", "patch", "additions", "deletions", "binary", "truncated", "revision"})
	requireExactObject(t, schema.Defs, "gitBranch", []string{"name", "kind", "current", "head", "upstream"})
	requireExactObject(t, schema.Defs, "gitBranchesResult", []string{"items", "truncated", "revision"})
	requireExactObject(t, schema.Defs, "worktreeMutationResult", []string{
		"operation_id", "workspace_id", "tab_id", "pane_id", "path", "branch", "outcome",
	})
	requireExactObjectFields(t, schema.Defs, "openWorktreeResult",
		[]string{"operation_id", "workspace_id", "tab_id", "pane_id", "path", "branch", "outcome"},
		[]string{"operation_id", "workspace_id", "path", "branch", "outcome"},
	)
	requireExactObject(t, schema.Defs, "paneMutationResult", []string{"operation_id", "pane_id", "outcome"})
	requireExactObject(t, schema.Defs, "terminalOpenResult", []string{
		"operation_id", "terminal_id", "pane_id", "cols", "rows", "encoding",
	})
	requireExactObject(t, schema.Defs, "terminalCommandResult", []string{
		"operation_id", "terminal_id", "accepted_seq", "duplicate",
	})
	requireExactObject(t, schema.Defs, "terminalCloseResult", []string{
		"operation_id", "terminal_id", "closed",
	})
	requireExactObject(t, schema.Defs, "transportOfferResult", []string{
		"attempt_id", "route_id", "sdp",
	})
	requireExactObject(t, schema.Defs, "transportCommitResult", []string{
		"attempt_id", "route_id", "transport",
	})

	aliases := map[string]string{
		"createTabResult":      "#/$defs/createdPaneResult",
		"splitPaneResult":      "#/$defs/createdPaneResult",
		"createWorktreeResult": "#/$defs/worktreeMutationResult",
		"resizePaneResult":     "#/$defs/paneMutationResult",
		"swapPaneResult":       "#/$defs/paneMutationResult",
		"zoomPaneResult":       "#/$defs/paneMutationResult",
	}
	for name, wantRef := range aliases {
		if got := schema.Defs[name].Ref; got != wantRef {
			t.Errorf("$defs.%s ref = %q, want %q", name, got, wantRef)
		}
	}

	if got := schema.Defs["appliedOutcome"].Enum; !slices.Equal(got, []string{"applied"}) {
		t.Errorf("applied outcome enum = %q", got)
	}
	if got := schema.Defs["appliedOrNoopOutcome"].Enum; !slices.Equal(got, []string{"applied", "noop"}) {
		t.Errorf("applied-or-noop outcome enum = %q", got)
	}
	for _, name := range []string{"createConversationResult", "createdPaneResult", "promptAgentResult", "worktreeMutationResult"} {
		if got := schema.Defs[name].Properties["outcome"].Ref; got != "#/$defs/appliedOutcome" {
			t.Errorf("$defs.%s outcome ref = %q", name, got)
		}
	}
	for _, name := range []string{"openWorktreeResult", "paneMutationResult"} {
		if got := schema.Defs[name].Properties["outcome"].Ref; got != "#/$defs/appliedOrNoopOutcome" {
			t.Errorf("$defs.%s outcome ref = %q", name, got)
		}
	}
	for _, name := range []string{
		"createConversationResult", "createdPaneResult", "promptAgentResult", "worktreeMutationResult",
		"openWorktreeResult", "paneMutationResult", "terminalOpenResult", "terminalCommandResult", "terminalCloseResult",
	} {
		if got := schema.Defs[name].Properties["operation_id"].Ref; got != "#/$defs/operationId" {
			t.Errorf("$defs.%s operation_id ref = %q", name, got)
		}
	}
	if got := schema.Defs["getConfigResult"].Properties["runtime"].Enum; !slices.Equal(got, []string{"herdr", "fake", "offline"}) {
		t.Errorf("runtime enum = %q", got)
	}
	if got := schema.Defs["getConfigResult"].Properties["submit_keys"].Items.Enum; !slices.Equal(got, []string{"Enter"}) {
		t.Errorf("submit key enum = %q", got)
	}
	if got := schema.Defs["promptAgentResult"].Properties["agent_status"].Enum; !slices.Equal(got, []string{"blocked", "working", "done", "idle", "unknown"}) {
		t.Errorf("agent status enum = %q", got)
	}
	if got := schema.Defs["historyItem"].Properties["role"].Enum; !slices.Equal(got, []string{"user", "assistant"}) {
		t.Errorf("history role enum = %q", got)
	}
	if got := schema.Defs["historyResult"].Properties["items"].Items.Ref; got != "#/$defs/historyItem" {
		t.Errorf("history items ref = %q", got)
	}
	// command, compaction and interrupt are opt-in via params.markers.
	traceTypes := []string{"user", "thinking", "tool", "assistant", "command", "compaction", "interrupt"}
	if got := schema.Defs["agentTraceItem"].Properties["type"].Enum; !slices.Equal(got, traceTypes) {
		t.Errorf("agent trace type enum = %q", got)
	}
	if got := schema.Defs["agentTraceResult"].Properties["items"].Items.Ref; got != "#/$defs/agentTraceItem" {
		t.Errorf("agent trace items ref = %q", got)
	}
	if got := schema.Defs["agentTraceSummaryItem"].Properties["type"].Enum; !slices.Equal(got, traceTypes) {
		t.Errorf("agent trace summary type enum = %q", got)
	}
	if got := schema.Defs["agentTraceSummaryItem"].Properties["state"].Enum; !slices.Equal(got, []string{"running", "done", "error"}) {
		t.Errorf("agent trace summary state enum = %q", got)
	}
	if got := schema.Defs["agentTraceSummaryResult"].Properties["items"].Items.Ref; got != "#/$defs/agentTraceSummaryItem" {
		t.Errorf("agent trace summary items ref = %q", got)
	}
	if got := schema.Defs["listWorktreesResult"].Properties["worktrees"].Items.Ref; got != "#/$defs/worktreeItem" {
		t.Errorf("worktree items ref = %q", got)
	}
}
