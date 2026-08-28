package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

func (h *Herdr) Execute(ctx context.Context, session SessionRef, operationID string, command Command) (Receipt, error) {
	if operationID == "" || len(operationID) > 128 || !utf8.ValidString(operationID) {
		return Receipt{OperationID: operationID, Outcome: OutcomeNotApplied}, invalidFault("execute", "valid operation id is required")
	}
	if feature, operation, extended := commandFeature(command); extended {
		if err := h.requireFeature(ctx, session, feature, operation); err != nil {
			return notApplied(operationID, err)
		}
	}
	switch value := command.(type) {
	case SendTextCommand:
		if value.PaneID == "" {
			return notApplied(operationID, invalidFault("pane.send_text", "pane id is required"))
		}
		return h.simpleMutation(ctx, session, operationID, "pane.send_text", map[string]any{"pane_id": value.PaneID, "text": value.Text}, EntityRef{Kind: EntityPane, ID: value.PaneID})
	case SendKeysCommand:
		if value.PaneID == "" || len(value.Keys) == 0 {
			return notApplied(operationID, invalidFault("pane.send_keys", "pane id and keys are required"))
		}
		keys, ok := canonicalSendKeys(value.Keys)
		if !ok {
			return notApplied(operationID, invalidFault("pane.send_keys", "invalid key"))
		}
		return h.simpleMutation(ctx, session, operationID, "pane.send_keys", map[string]any{"pane_id": value.PaneID, "keys": keys}, EntityRef{Kind: EntityPane, ID: value.PaneID})
	case RenamePaneCommand:
		if value.PaneID == "" {
			return notApplied(operationID, invalidFault("pane.rename", "pane id is required"))
		}
		return h.simpleMutation(ctx, session, operationID, "pane.rename", map[string]any{"pane_id": value.PaneID, "label": value.Label}, EntityRef{Kind: EntityPane, ID: value.PaneID})
	case RenameTabCommand:
		if value.TabID == "" || value.Label == "" {
			return notApplied(operationID, invalidFault("tab.rename", "tab id and label are required"))
		}
		return h.simpleMutation(ctx, session, operationID, "tab.rename", map[string]any{"tab_id": value.TabID, "label": value.Label}, EntityRef{Kind: EntityTab, ID: value.TabID})
	case RenameWorkspaceCommand:
		if value.WorkspaceID == "" || value.Label == "" {
			return notApplied(operationID, invalidFault("workspace.rename", "workspace id and label are required"))
		}
		return h.simpleMutation(ctx, session, operationID, "workspace.rename", map[string]any{"workspace_id": value.WorkspaceID, "label": value.Label}, EntityRef{Kind: EntityWorkspace, ID: value.WorkspaceID})
	case ClosePaneCommand:
		if value.PaneID == "" {
			return notApplied(operationID, invalidFault("pane.close", "pane id is required"))
		}
		return h.closeMutation(ctx, session, operationID, "pane.close", map[string]any{"pane_id": value.PaneID}, EntityRef{Kind: EntityPane, ID: value.PaneID})
	case CloseTabCommand:
		if value.TabID == "" {
			return notApplied(operationID, invalidFault("tab.close", "tab id is required"))
		}
		return h.closeMutation(ctx, session, operationID, "tab.close", map[string]any{"tab_id": value.TabID}, EntityRef{Kind: EntityTab, ID: value.TabID})
	case CreateConversationCommand:
		return h.createConversation(ctx, session, operationID, value)
	case CreateTabCommand:
		return h.createTab(ctx, session, operationID, value)
	case SplitPaneCommand:
		return h.splitPane(ctx, session, operationID, value)
	case PromptAgentCommand:
		return h.promptAgent(ctx, session, operationID, value)
	case WorktreeCreateCommand:
		return h.changeWorktree(ctx, session, operationID, "worktree.create", value)
	case WorktreeOpenCommand:
		return h.changeWorktree(ctx, session, operationID, "worktree.open", value)
	case ResizePaneCommand:
		return h.resizePane(ctx, session, operationID, value)
	case SwapPaneCommand:
		return h.swapPane(ctx, session, operationID, value)
	case ZoomPaneCommand:
		return h.zoomPane(ctx, session, operationID, value)
	default:
		return notApplied(operationID, unsupported("execute", "unknown runtime command"))
	}
}

func commandFeature(command Command) (Feature, string, bool) {
	switch command.(type) {
	case CreateTabCommand:
		return FeatureCreateTab, "tab.create", true
	case SplitPaneCommand:
		return FeatureSplitPane, "pane.split", true
	case PromptAgentCommand:
		return FeaturePromptAgent, "agent.prompt", true
	case WorktreeCreateCommand:
		return FeatureWorktreeCreate, "worktree.create", true
	case WorktreeOpenCommand:
		return FeatureWorktreeOpen, "worktree.open", true
	case ResizePaneCommand:
		return FeatureLayoutResize, "pane.resize", true
	case SwapPaneCommand:
		return FeatureLayoutSwap, "pane.swap", true
	case ZoomPaneCommand:
		return FeatureLayoutZoom, "pane.zoom", true
	default:
		return "", "", false
	}
}

func (h *Herdr) requireFeature(ctx context.Context, session SessionRef, feature Feature, operation string) error {
	snapshot, err := h.snapshot(ctx, session)
	if err != nil {
		return err
	}
	if !capabilities(snapshot.HerdrProtocol)[feature].Available {
		return unsupported(operation, "operation is unsupported by the live Herdr protocol")
	}
	return nil
}

func (h *Herdr) simpleMutation(ctx context.Context, session SessionRef, operationID, method string, params any, target EntityRef) (Receipt, error) {
	raw, err := h.call(ctx, session, method, params, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	if err := expectResponseType(raw, method, "ok"); err != nil {
		return receiptForError(operationID, err), err
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{target}}, nil
}

func (h *Herdr) closeMutation(ctx context.Context, session SessionRef, operationID, method string, params any, target EntityRef) (Receipt, error) {
	raw, err := h.call(ctx, session, method, params, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	if err := expectResponseType(raw, method, "ok"); err != nil {
		return receiptForError(operationID, err), err
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Removed: []EntityRef{target}}, nil
}

func (h *Herdr) createConversation(ctx context.Context, session SessionRef, operationID string, command CreateConversationCommand) (Receipt, error) {
	if command.CWD != "" && !filepath.IsAbs(command.CWD) {
		return notApplied(operationID, invalidFault("create_conversation", "cwd must be absolute"))
	}
	descriptor, err := h.Describe(ctx, session)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	if !descriptor.Supports(FeatureCreateConversation) {
		return notApplied(operationID, unsupported("create_conversation", "operation is unsupported by the live Herdr protocol"))
	}
	name := command.AgentName
	if command.AgentKind != "" {
		if !containsAgent(descriptor.AgentKinds, command.AgentKind) {
			return notApplied(operationID, unsupported("create_conversation", "agent kind is not available from the live Herdr manifests"))
		}
		if name == "" {
			name = generatedAgentName(command.AgentKind, operationID)
		}
		if !validAgentName.MatchString(name) {
			return notApplied(operationID, invalidFault("create_conversation", "invalid agent name"))
		}
	}
	raw, err := h.call(ctx, session, "workspace.create", map[string]any{
		"cwd": optionalString(command.CWD), "label": optionalString(command.Label), "focus": false,
	}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	var created struct {
		Type      string             `json:"type"`
		Workspace herdrWorkspaceWire `json:"workspace"`
		Tab       herdrTabWire       `json:"tab"`
		RootPane  herdrPaneWire      `json:"root_pane"`
	}
	if err := json.Unmarshal(raw, &created); err != nil || created.Type != "workspace_created" || !validResourceID.MatchString(created.Workspace.WorkspaceID) || !validResourceID.MatchString(created.Tab.TabID) || !validResourceID.MatchString(created.RootPane.PaneID) {
		fault := responseFault("workspace.create", "invalid Herdr workspace create response", err, true)
		return receiptForError(operationID, fault), fault
	}
	createdRefs := []EntityRef{
		{Kind: EntityWorkspace, ID: created.Workspace.WorkspaceID},
		{Kind: EntityTab, ID: created.Tab.TabID},
		{Kind: EntityPane, ID: created.RootPane.PaneID},
	}
	if command.AgentKind == "" {
		return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: createdRefs}, nil
	}
	result, startErr := h.callWithTimeout(ctx, session, "agent.start", map[string]any{
		"name": name, "kind": command.AgentKind, "pane_id": created.RootPane.PaneID, "timeout_ms": 30000,
	}, true, 35*time.Second)
	if startErr != nil {
		return h.compensateConversation(ctx, session, operationID, createdRefs, created.Workspace.WorkspaceID, startErr)
	}
	var started struct {
		Type  string `json:"type"`
		Agent struct {
			Name   *string `json:"name"`
			PaneID string  `json:"pane_id"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(result, &started); err != nil || started.Type != "agent_started" || started.Agent.PaneID != created.RootPane.PaneID || !validResourceID.MatchString(started.Agent.PaneID) || (started.Agent.Name != nil && *started.Agent.Name != "" && !validAgentName.MatchString(*started.Agent.Name)) {
		fault := responseFault("agent.start", "invalid Herdr agent start response", err, true)
		receipt := Receipt{OperationID: operationID, Outcome: OutcomeUnknown, Created: createdRefs}
		return receipt, fault
	}
	agentID := name
	if started.Agent.Name != nil && *started.Agent.Name != "" {
		agentID = *started.Agent.Name
	}
	createdRefs = append(createdRefs, EntityRef{Kind: EntityAgent, ID: agentID})
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: createdRefs}, nil
}

func (h *Herdr) compensateConversation(ctx context.Context, session SessionRef, operationID string, created []EntityRef, workspaceID string, startErr error) (Receipt, error) {
	fault, ok := AsFault(startErr)
	if !ok || fault.Outcome == OutcomeUnknown {
		return Receipt{OperationID: operationID, Outcome: OutcomeUnknown, Created: created}, startErr
	}
	closeRaw, closeErr := h.call(ctx, session, "workspace.close", map[string]any{"workspace_id": workspaceID}, true)
	if closeErr == nil {
		closeErr = expectResponseType(closeRaw, "workspace.close", "ok")
	}
	if closeErr == nil {
		fault.Outcome = OutcomeNotApplied
		return Receipt{OperationID: operationID, Outcome: OutcomeNotApplied, Removed: created}, fault
	}
	closeFault, closeIsFault := AsFault(closeErr)
	outcome := OutcomePartial
	if closeIsFault && closeFault.Outcome == OutcomeUnknown {
		outcome = OutcomeUnknown
	}
	fault.Outcome = outcome
	fault.SafeMessage = fault.SafeMessage + "; failed to remove the newly created workspace"
	return Receipt{OperationID: operationID, Outcome: outcome, Created: created}, fault
}

func (h *Herdr) createTab(ctx context.Context, session SessionRef, operationID string, command CreateTabCommand) (Receipt, error) {
	if !validResourceID.MatchString(command.WorkspaceID) || (command.CWD != "" && !filepath.IsAbs(command.CWD)) {
		return notApplied(operationID, invalidFault("tab.create", "workspace id and an absolute cwd are required"))
	}
	raw, err := h.call(ctx, session, "tab.create", map[string]any{
		"workspace_id": command.WorkspaceID, "cwd": optionalString(command.CWD),
		"label": optionalString(command.Label), "focus": false,
	}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	var created struct {
		Type     string        `json:"type"`
		Tab      herdrTabWire  `json:"tab"`
		RootPane herdrPaneWire `json:"root_pane"`
	}
	if err := json.Unmarshal(raw, &created); err != nil || created.Type != "tab_created" || !validResourceID.MatchString(created.Tab.TabID) || !validResourceID.MatchString(created.RootPane.PaneID) {
		fault := responseFault("tab.create", "invalid Herdr tab create response", err, true)
		return receiptForError(operationID, fault), fault
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: []EntityRef{
		{Kind: EntityTab, ID: created.Tab.TabID}, {Kind: EntityPane, ID: created.RootPane.PaneID},
	}}, nil
}

func (h *Herdr) splitPane(ctx context.Context, session SessionRef, operationID string, command SplitPaneCommand) (Receipt, error) {
	if !validResourceID.MatchString(command.TargetPaneID) || (command.Direction != SplitRight && command.Direction != SplitDown) || (command.CWD != "" && !filepath.IsAbs(command.CWD)) {
		return notApplied(operationID, invalidFault("pane.split", "target pane, direction, and an absolute cwd are required"))
	}
	if command.Ratio != nil && (*command.Ratio <= 0 || *command.Ratio >= 1) {
		return notApplied(operationID, invalidFault("pane.split", "ratio must be between zero and one"))
	}
	raw, err := h.call(ctx, session, "pane.split", map[string]any{
		"workspace_id": optionalString(command.WorkspaceID), "target_pane_id": command.TargetPaneID,
		"cwd": optionalString(command.CWD), "direction": command.Direction, "ratio": command.Ratio,
		"right_click": "herdr", "focus": false,
	}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	var created struct {
		Type string        `json:"type"`
		Pane herdrPaneWire `json:"pane"`
	}
	if err := json.Unmarshal(raw, &created); err != nil || created.Type != "pane_info" || !validResourceID.MatchString(created.Pane.PaneID) {
		fault := responseFault("pane.split", "invalid Herdr pane split response", err, true)
		return receiptForError(operationID, fault), fault
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Created: []EntityRef{{Kind: EntityPane, ID: created.Pane.PaneID}}}, nil
}

func (h *Herdr) promptAgent(ctx context.Context, session SessionRef, operationID string, command PromptAgentCommand) (Receipt, error) {
	if command.Target == "" || command.Text == "" {
		return notApplied(operationID, invalidFault("agent.prompt", "agent target and prompt are required"))
	}
	raw, err := h.call(ctx, session, "agent.prompt", map[string]any{"target": command.Target, "text": command.Text}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	var prompted struct {
		Type  string `json:"type"`
		Agent struct {
			PaneID string `json:"pane_id"`
			Name   string `json:"name"`
		} `json:"agent"`
	}
	if err := json.Unmarshal(raw, &prompted); err != nil || prompted.Type != "agent_prompted" || !validOptionalResourceID(prompted.Agent.PaneID) || (prompted.Agent.Name != "" && !validAgentName.MatchString(prompted.Agent.Name)) {
		fault := responseFault("agent.prompt", "invalid Herdr agent prompt response", err, true)
		return receiptForError(operationID, fault), fault
	}
	id := prompted.Agent.Name
	if id == "" {
		id = command.Target
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{{Kind: EntityAgent, ID: id}}}, nil
}

func (h *Herdr) changeWorktree(ctx context.Context, session SessionRef, operationID, method string, command any) (Receipt, error) {
	params := map[string]any{"focus": false}
	switch value := command.(type) {
	case WorktreeCreateCommand:
		params["workspace_id"] = optionalString(value.WorkspaceID)
		params["cwd"] = optionalString(value.CWD)
		params["branch"] = optionalString(value.Branch)
		params["base"] = optionalString(value.Base)
		params["path"] = optionalString(value.Path)
		params["label"] = optionalString(value.Label)
	case WorktreeOpenCommand:
		params["workspace_id"] = optionalString(value.WorkspaceID)
		params["cwd"] = optionalString(value.CWD)
		params["branch"] = optionalString(value.Branch)
		params["path"] = optionalString(value.Path)
		params["label"] = optionalString(value.Label)
	}
	raw, err := h.call(ctx, session, method, params, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	var changed struct {
		Type      string             `json:"type"`
		Workspace herdrWorkspaceWire `json:"workspace"`
		Tab       herdrTabWire       `json:"tab"`
		RootPane  herdrPaneWire      `json:"root_pane"`
		Worktree  struct {
			Path string `json:"path"`
		} `json:"worktree"`
		AlreadyOpen bool `json:"already_open"`
	}
	wantType := "worktree_created"
	if method == "worktree.open" {
		wantType = "worktree_opened"
	}
	invalid := json.Unmarshal(raw, &changed) != nil || changed.Type != wantType || !validResourceID.MatchString(changed.Workspace.WorkspaceID) || changed.Worktree.Path == ""
	if method == "worktree.create" {
		invalid = invalid || !validResourceID.MatchString(changed.Tab.TabID) || !validResourceID.MatchString(changed.RootPane.PaneID)
	} else {
		invalid = invalid || !validOptionalResourceID(changed.Tab.TabID) || !validOptionalResourceID(changed.RootPane.PaneID)
	}
	if invalid {
		fault := responseFault(method, "invalid Herdr worktree response", nil, true)
		return receiptForError(operationID, fault), fault
	}
	outcome := OutcomeApplied
	if changed.AlreadyOpen {
		outcome = OutcomeNoop
	}
	refs := []EntityRef{{Kind: EntityWorkspace, ID: changed.Workspace.WorkspaceID}}
	if changed.Tab.TabID != "" {
		refs = append(refs, EntityRef{Kind: EntityTab, ID: changed.Tab.TabID})
	}
	if changed.RootPane.PaneID != "" {
		refs = append(refs, EntityRef{Kind: EntityPane, ID: changed.RootPane.PaneID})
	}
	if changed.Worktree.Path != "" {
		refs = append(refs, EntityRef{Kind: EntityWorktree, ID: changed.Worktree.Path})
	}
	return Receipt{OperationID: operationID, Outcome: outcome, Created: refs}, nil
}

func (h *Herdr) resizePane(ctx context.Context, session SessionRef, operationID string, command ResizePaneCommand) (Receipt, error) {
	if command.PaneID == "" || !validPaneDirection(command.Direction) {
		return notApplied(operationID, invalidFault("pane.resize", "pane id and valid direction are required"))
	}
	raw, err := h.call(ctx, session, "pane.resize", map[string]any{"pane_id": command.PaneID, "direction": command.Direction, "amount": command.Amount}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	changed, err := changedResult(raw, "pane_resize", "resize")
	if err != nil {
		return receiptForError(operationID, err), err
	}
	return changedReceipt(operationID, changed, EntityRef{Kind: EntityPane, ID: command.PaneID}), nil
}

func (h *Herdr) swapPane(ctx context.Context, session SessionRef, operationID string, command SwapPaneCommand) (Receipt, error) {
	if command.PaneID == "" || !validPaneDirection(command.Direction) {
		return notApplied(operationID, invalidFault("pane.swap", "pane id and valid direction are required"))
	}
	raw, err := h.call(ctx, session, "pane.swap", map[string]any{"pane_id": command.PaneID, "direction": command.Direction}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	changed, err := changedResult(raw, "pane_swap", "swap")
	if err != nil {
		return receiptForError(operationID, err), err
	}
	return changedReceipt(operationID, changed, EntityRef{Kind: EntityPane, ID: command.PaneID}), nil
}

func (h *Herdr) zoomPane(ctx context.Context, session SessionRef, operationID string, command ZoomPaneCommand) (Receipt, error) {
	if command.PaneID == "" || (command.Mode != ZoomToggle && command.Mode != ZoomOn && command.Mode != ZoomOff) {
		return notApplied(operationID, invalidFault("pane.zoom", "pane id and valid zoom mode are required"))
	}
	raw, err := h.call(ctx, session, "pane.zoom", map[string]any{"pane_id": command.PaneID, "mode": command.Mode}, true)
	if err != nil {
		return receiptForError(operationID, err), err
	}
	changed, err := changedResult(raw, "pane_zoom", "zoom")
	if err != nil {
		return receiptForError(operationID, err), err
	}
	return changedReceipt(operationID, changed, EntityRef{Kind: EntityPane, ID: command.PaneID}), nil
}

func changedResult(raw json.RawMessage, wantType, field string) (bool, error) {
	var response struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.Type != wantType {
		return false, responseFault(wantType, "invalid Herdr layout response", err, true)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return false, responseFault(wantType, "invalid Herdr layout response", err, true)
	}
	var result struct {
		Changed bool `json:"changed"`
	}
	if err := json.Unmarshal(object[field], &result); err != nil {
		return false, responseFault(wantType, "invalid Herdr layout result", err, true)
	}
	return result.Changed, nil
}

func changedReceipt(operationID string, changed bool, target EntityRef) Receipt {
	if !changed {
		return Receipt{OperationID: operationID, Outcome: OutcomeNoop}
	}
	return Receipt{OperationID: operationID, Outcome: OutcomeApplied, Updated: []EntityRef{target}}
}

func expectResponseType(raw json.RawMessage, operation, wanted string) error {
	var response struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.Type != wanted {
		return responseFault(operation, "invalid Herdr mutation response", err, true)
	}
	return nil
}

func validPaneDirection(direction PaneDirection) bool {
	return direction == PaneLeft || direction == PaneRight || direction == PaneUp || direction == PaneDown
}

func optionalString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func containsAgent(kinds []AgentKind, wanted string) bool {
	for _, kind := range kinds {
		if kind.Kind == wanted {
			return true
		}
	}
	return false
}

func generatedAgentName(kind, operationID string) string {
	base := strings.ToLower(kind)
	base = regexp.MustCompile(`[^a-z0-9_-]+`).ReplaceAllString(base, "-")
	base = strings.Trim(base, "-_")
	if base == "" || base[0] < 'a' || base[0] > 'z' {
		base = "agent"
	}
	if len(base) > 20 {
		base = base[:20]
	}
	sum := sha256.Sum256([]byte(operationID))
	return base + "-" + hex.EncodeToString(sum[:4])
}

func receiptForError(operationID string, err error) Receipt {
	outcome := OutcomeNotApplied
	if fault, ok := AsFault(err); ok && fault.Outcome != "" {
		outcome = fault.Outcome
	}
	return Receipt{OperationID: operationID, Outcome: outcome}
}

func notApplied(operationID string, err error) (Receipt, error) {
	return Receipt{OperationID: operationID, Outcome: OutcomeNotApplied}, err
}
