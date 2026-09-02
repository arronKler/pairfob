package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"unicode/utf8"

	"pairfob/internal/runtime"
)

func (e *Engine) rpcRenamePane(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string         `json:"session"`
		OperationID string          `json:"operation_id"`
		PaneID      string          `json:"pane_id"`
		Label       json.RawMessage `json:"label"`
	}
	if badParams(params, &p) {
		e.replyErr(s, id, "too_large", "invalid label")
		return
	}
	var label *string
	if len(p.Label) > 0 && string(p.Label) != "null" {
		var value string
		if json.Unmarshal(p.Label, &value) == nil {
			label = &value
		}
	}
	if len(p.Label) == 0 || (string(p.Label) != "null" && label == nil) || !validID(p.PaneID) || invalidSession(p.Session) || (label != nil && (utf8.RuneCountInString(*label) > maxLabelBytes || !utf8.ValidString(*label))) {
		e.replyErr(s, id, "too_large", "invalid label")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.RenamePaneCommand{PaneID: p.PaneID, Label: label}, "pane_not_found")
	if !ok {
		return
	}
	e.audit("rename_pane", map[string]any{"device_id": s.deviceID, "pane_id": p.PaneID})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcRenameTab(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		TabID       string  `json:"tab_id"`
		Label       string  `json:"label"`
	}
	if badParams(params, &p) || !validID(p.TabID) || invalidSession(p.Session) || p.Label == "" || utf8.RuneCountInString(p.Label) > maxLabelBytes || !utf8.ValidString(p.Label) {
		e.replyErr(s, id, "too_large", "invalid label")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.RenameTabCommand{TabID: p.TabID, Label: p.Label}, "tab_not_found")
	if !ok {
		return
	}
	e.audit("rename_tab", map[string]any{"device_id": s.deviceID, "tab_id": p.TabID})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcRenameWorkspace(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		WorkspaceID string  `json:"workspace_id"`
		Label       string  `json:"label"`
	}
	if badParams(params, &p) || !validID(p.WorkspaceID) || invalidSession(p.Session) || p.Label == "" || utf8.RuneCountInString(p.Label) > maxLabelBytes || !utf8.ValidString(p.Label) {
		e.replyErr(s, id, "too_large", "invalid label")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.RenameWorkspaceCommand{WorkspaceID: p.WorkspaceID, Label: p.Label}, "workspace_not_found")
	if !ok {
		return
	}
	e.audit("rename_workspace", map[string]any{"device_id": s.deviceID, "workspace_id": p.WorkspaceID})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcClosePane(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		PaneID      string  `json:"pane_id"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.ClosePaneCommand{PaneID: p.PaneID}, "pane_not_found")
	if !ok {
		return
	}
	e.audit("close_pane", map[string]any{"device_id": s.deviceID, "pane_id": p.PaneID})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcCloseTab(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		TabID       string  `json:"tab_id"`
	}
	if badParams(params, &p) || !validID(p.TabID) || invalidSession(p.Session) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.CloseTabCommand{TabID: p.TabID}, "tab_not_found")
	if !ok {
		return
	}
	e.audit("close_tab", map[string]any{"device_id": s.deviceID, "tab_id": p.TabID})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcCloseWorkspace(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		WorkspaceID string  `json:"workspace_id"`
	}
	if badParams(params, &p) || !validID(p.WorkspaceID) || invalidSession(p.Session) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.CloseWorkspaceCommand{WorkspaceID: p.WorkspaceID}, "workspace_not_found")
	if !ok {
		return
	}
	e.audit("close_workspace", map[string]any{"device_id": s.deviceID, "workspace_id": p.WorkspaceID})
	e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
}

func (e *Engine) rpcCreateConversation(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		CWD         string  `json:"cwd"`
		AgentKind   string  `json:"agent_kind"`
		Label       string  `json:"label"`
	}
	if badParams(params, &p) || invalidSession(p.Session) || !operationName.MatchString(p.OperationID) || !validPath(p.CWD) || (p.AgentKind != "" && !agentKind.MatchString(p.AgentKind)) || !validOptionalText(p.Label, maxLabelBytes) {
		e.replyErr(s, id, "invalid_argument", "invalid create conversation params")
		return
	}
	if err := e.pathAllowed(p.Session, p.CWD, false); err != nil {
		e.replyErr(s, id, "invalid_argument", "cwd is outside allowed local roots")
		return
	}
	p.CWD, _ = resolvedPath(p.CWD)
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.CreateConversationCommand{CWD: p.CWD, Label: p.Label, AgentKind: p.AgentKind}, "workspace_not_found")
	if !ok {
		return
	}
	result := receiptEntities(receipt)
	result["operation_id"] = operationID
	if p.AgentKind != "" {
		result["agent_kind"] = p.AgentKind
	}
	e.audit("create_conversation", map[string]any{"device_id": s.deviceID, "agent_kind": p.AgentKind, "outcome": receipt.Outcome})
	e.reply(s, id, result)
}

func (e *Engine) rpcCreateTab(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		WorkspaceID string  `json:"workspace_id"`
		CWD         string  `json:"cwd"`
		Label       string  `json:"label"`
	}
	if badParams(params, &p) || invalidSession(p.Session) || !validID(p.WorkspaceID) || !validMaybePath(p.CWD) || !validOptionalText(p.Label, maxLabelBytes) {
		e.replyErr(s, id, "invalid_argument", "invalid create tab params")
		return
	}
	if p.CWD != "" {
		if err := e.pathAllowed(p.Session, p.CWD, false); err != nil {
			e.replyErr(s, id, "invalid_argument", "cwd is outside allowed local roots")
			return
		}
		p.CWD, _ = resolvedPath(p.CWD)
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.CreateTabCommand{WorkspaceID: p.WorkspaceID, CWD: p.CWD, Label: p.Label}, "workspace_not_found")
	if !ok {
		return
	}
	result := receiptEntities(receipt)
	result["workspace_id"], result["operation_id"] = p.WorkspaceID, operationID
	e.audit("create_tab", map[string]any{"device_id": s.deviceID, "workspace_id": p.WorkspaceID, "outcome": receipt.Outcome})
	e.reply(s, id, result)
}

func (e *Engine) rpcSplitPane(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string                `json:"session"`
		OperationID string                 `json:"operation_id"`
		PaneID      string                 `json:"pane_id"`
		Direction   runtime.SplitDirection `json:"direction"`
		CWD         string                 `json:"cwd"`
		Ratio       *float64               `json:"ratio"`
	}
	if badParams(params, &p) || invalidSession(p.Session) || !validID(p.PaneID) || (p.Direction != runtime.SplitRight && p.Direction != runtime.SplitDown) || !validMaybePath(p.CWD) || (p.Ratio != nil && (*p.Ratio <= 0 || *p.Ratio >= 1)) {
		e.replyErr(s, id, "invalid_argument", "invalid split pane params")
		return
	}
	pane, findErr := e.findPane(p.Session, p.PaneID)
	if findErr != nil {
		e.replyRuntimeErr(s, id, findErr, "pane_not_found")
		return
	}
	if pane == nil {
		e.replyErr(s, id, "pane_not_found", "pane is no longer available")
		return
	}
	if p.CWD != "" {
		if err := e.pathAllowed(p.Session, p.CWD, false); err != nil {
			e.replyErr(s, id, "invalid_argument", "cwd is outside allowed local roots")
			return
		}
		p.CWD, _ = resolvedPath(p.CWD)
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, runtime.SplitPaneCommand{WorkspaceID: pane.WorkspaceID, TargetPaneID: p.PaneID, CWD: p.CWD, Direction: p.Direction, Ratio: p.Ratio}, "pane_not_found")
	if !ok {
		return
	}
	result := receiptEntities(receipt)
	result["workspace_id"], result["tab_id"], result["operation_id"] = pane.WorkspaceID, pane.TabID, operationID
	e.audit("split_pane", map[string]any{"device_id": s.deviceID, "pane_id": p.PaneID, "direction": p.Direction, "outcome": receipt.Outcome})
	e.reply(s, id, result)
}

func (e *Engine) rpcRevokeDevice(s *sess, id string, params json.RawMessage) {
	var p struct {
		OperationID string `json:"operation_id"`
		DeviceID    string `json:"device_id"`
		Reason      string `json:"reason"`
	}
	if badParams(params, &p) || !validDeviceID(p.DeviceID) || utf8.RuneCountInString(p.Reason) > 256 {
		e.replyErr(s, id, "forbidden", "invalid revoke")
		return
	}
	operationID, ok := mutationOperationID(p.OperationID, id, true)
	if !ok {
		e.replyErr(s, id, "invalid_argument", "invalid operation_id")
		return
	}
	intent := struct {
		DeviceID string `json:"device_id"`
		Reason   string `json:"reason"`
	}{DeviceID: p.DeviceID, Reason: p.Reason}
	receipt, err := e.executeTrackedMutation(context.Background(), s.deviceID, runtime.DefaultSession(), operationID, intent, func() (runtime.Receipt, error) {
		if revokeErr := e.markDeviceRevoked(p.DeviceID); revokeErr != nil {
			return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeNotApplied}, revokeErr
		}
		return runtime.Receipt{OperationID: operationID, Outcome: runtime.OutcomeApplied}, nil
	})
	if err != nil {
		if errors.Is(err, errRevoked) {
			_ = e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
			return
		}
		e.replyErr(s, id, "internal", "persistent device update failed")
		return
	}
	defer e.closeDeviceSessions(p.DeviceID, "revoked")
	_ = e.reply(s, id, map[string]any{"ok": true, "operation_id": operationID, "outcome": receipt.Outcome})
	e.audit("device_revoke_requested", map[string]any{
		"device_id": p.DeviceID, "actor_device_id": s.deviceID, "has_reason": p.Reason != "",
	})
}

func (e *Engine) rpcListDevices(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	e.mu.Lock()
	list := make([]map[string]any, 0, len(e.Devices))
	for _, d := range e.Devices {
		if d.RevokedAt != nil {
			continue
		}
		list = append(list, map[string]any{
			"device_id": d.ID, "label": d.Label, "created_at": d.Created,
			"last_seen": d.LastSeen, "self": d.ID == s.deviceID,
			"connected":          e.deviceConnectedLocked(d.ID),
			"subscription_count": len(d.PushSubscriptions),
		})
	}
	e.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		aSelf, _ := a["self"].(bool)
		bSelf, _ := b["self"].(bool)
		if aSelf != bSelf {
			return aSelf
		}
		aOn, _ := a["connected"].(bool)
		bOn, _ := b["connected"].(bool)
		if aOn != bOn {
			return aOn
		}
		aSeen, _ := a["last_seen"].(int64)
		bSeen, _ := b["last_seen"].(int64)
		if aSeen != bSeen {
			return aSeen > bSeen
		}
		aID, _ := a["device_id"].(string)
		bID, _ := b["device_id"].(string)
		return aID < bID
	})
	e.reply(s, id, map[string]any{"devices": list})
}
