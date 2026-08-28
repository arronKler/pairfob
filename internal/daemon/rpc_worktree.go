package daemon

import (
	"encoding/json"

	"pairfob/internal/runtime"
)

func (e *Engine) rpcListWorktrees(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session     *string `json:"session"`
		WorkspaceID string  `json:"workspace_id"`
		CWD         string  `json:"cwd"`
	}
	if badParams(params, &p) || invalidSession(p.Session) || (p.WorkspaceID == "") == (p.CWD == "") || (p.WorkspaceID != "" && !validID(p.WorkspaceID)) || !validMaybePath(p.CWD) {
		e.replyErr(s, id, "invalid_argument", "invalid worktree selector")
		return
	}
	if p.CWD != "" {
		if err := e.pathAllowed(p.Session, p.CWD, false); err != nil {
			e.replyErr(s, id, "invalid_argument", "worktree source is outside allowed local roots")
			return
		}
		p.CWD, _ = resolvedPath(p.CWD)
	}
	view, err := e.observe(p.Session, runtime.WorktreeListQuery{WorkspaceID: p.WorkspaceID, CWD: p.CWD})
	if err != nil {
		e.replyRuntimeErr(s, id, err, "worktree_not_found")
		return
	}
	worktrees, ok := view.(runtime.WorktreeListView)
	if !ok {
		e.replyErr(s, id, "internal", "runtime returned an invalid worktree view")
		return
	}
	e.reply(s, id, map[string]any{"worktrees": worktreeItems(worktrees)})
}

func listedWorktree(view runtime.WorktreeListView, wantedPath, wantedBranch string) (runtime.Worktree, bool) {
	var resolvedWanted string
	if wantedPath != "" {
		var err error
		resolvedWanted, err = resolvedPath(wantedPath)
		if err != nil {
			return runtime.Worktree{}, false
		}
	}
	var match *runtime.Worktree
	for i := range view.Worktrees {
		worktree := &view.Worktrees[i]
		matches := wantedBranch != "" && worktree.Branch != nil && *worktree.Branch == wantedBranch
		if wantedPath != "" {
			resolved, resolveErr := resolvedPath(worktree.Path)
			matches = resolveErr == nil && resolved == resolvedWanted
		}
		if !matches {
			continue
		}
		if match != nil {
			return runtime.Worktree{}, false
		}
		match = worktree
	}
	if match == nil {
		return runtime.Worktree{}, false
	}
	return *match, true
}

func worktreeItems(view runtime.WorktreeListView) []map[string]any {
	items := make([]map[string]any, 0, len(view.Worktrees))
	for _, worktree := range view.Worktrees {
		var branch any
		if worktree.Branch != nil && *worktree.Branch != "" {
			branch = *worktree.Branch
		}
		var label any
		if worktree.Label != "" {
			label = worktree.Label
		}
		var openWorkspace any
		if worktree.OpenWorkspaceID != nil && *worktree.OpenWorkspaceID != "" {
			openWorkspace = *worktree.OpenWorkspaceID
		}
		items = append(items, map[string]any{
			"path": worktree.Path, "branch": branch, "label": label,
			"is_bare": worktree.Bare, "is_detached": worktree.Detached,
			"is_prunable": worktree.Prunable, "is_linked_worktree": worktree.Linked,
			"open_workspace_id": openWorkspace,
		})
	}
	return items
}

func (e *Engine) dispatchWorktreeMutation(s *sess, id string, params json.RawMessage, open bool) {
	var p struct {
		Session     *string `json:"session"`
		OperationID string  `json:"operation_id"`
		WorkspaceID string  `json:"workspace_id"`
		CWD         string  `json:"cwd"`
		Branch      string  `json:"branch"`
		Base        string  `json:"base"`
		Path        string  `json:"path"`
		Label       string  `json:"label"`
	}
	if badParams(params, &p) || invalidSession(p.Session) || (p.WorkspaceID == "") == (p.CWD == "") || (p.WorkspaceID != "" && !validID(p.WorkspaceID)) || !validMaybePath(p.CWD) || !validMaybePath(p.Path) || !validOptionalText(p.Branch, 512) || !validOptionalText(p.Base, 512) || !validOptionalText(p.Label, maxLabelBytes) {
		e.replyErr(s, id, "invalid_argument", "invalid worktree params")
		return
	}
	if open && ((p.Branch == "") == (p.Path == "") || p.Base != "") {
		e.replyErr(s, id, "invalid_argument", "open worktree requires exactly one branch or path")
		return
	}
	if p.CWD != "" {
		if err := e.pathAllowed(p.Session, p.CWD, false); err != nil {
			e.replyErr(s, id, "invalid_argument", "worktree source is outside allowed local roots")
			return
		}
		p.CWD, _ = resolvedPath(p.CWD)
	}
	resultBranch := p.Branch
	if open {
		view, err := e.observe(p.Session, runtime.WorktreeListQuery{WorkspaceID: p.WorkspaceID, CWD: p.CWD})
		if err != nil {
			e.replyRuntimeErr(s, id, err, "worktree_not_found")
			return
		}
		list, ok := view.(runtime.WorktreeListView)
		trusted, listed := listedWorktree(list, p.Path, p.Branch)
		if !ok || !listed || !validPath(trusted.Path) {
			e.replyErr(s, id, "worktree_not_found", "worktree is not uniquely reported by Herdr")
			return
		}
		if err := e.pathAllowed(p.Session, trusted.Path, false); err != nil {
			e.replyErr(s, id, "invalid_argument", "worktree is outside allowed roots")
			return
		}
		// Preserve Herdr's opaque-but-validated path spelling (for example /tmp
		// versus /private/tmp); containment checks above use its canonical form.
		p.Path = trusted.Path
		p.Branch = ""
		if trusted.Branch != nil {
			resultBranch = *trusted.Branch
		} else {
			resultBranch = ""
		}
	} else if p.Path != "" {
		if err := e.pathAllowed(p.Session, p.Path, true); err != nil {
			e.replyErr(s, id, "invalid_argument", "worktree path is outside allowed roots")
			return
		}
		p.Path, _ = resolvedPath(p.Path)
	}
	var command runtime.Command
	op := "create_worktree"
	if open {
		op = "open_worktree"
		command = runtime.WorktreeOpenCommand{WorkspaceID: p.WorkspaceID, CWD: p.CWD, Branch: p.Branch, Path: p.Path, Label: p.Label}
	} else {
		command = runtime.WorktreeCreateCommand{WorkspaceID: p.WorkspaceID, CWD: p.CWD, Branch: p.Branch, Base: p.Base, Path: p.Path, Label: p.Label}
	}
	receipt, operationID, ok := e.executeRPC(s, id, p.Session, p.OperationID, true, command, "worktree_not_found")
	if !ok {
		return
	}
	result := receiptEntities(receipt)
	result["operation_id"] = operationID
	if resultBranch != "" {
		result["branch"] = resultBranch
	} else {
		result["branch"] = nil
	}
	if _, exists := result["path"]; !exists && p.Path != "" {
		result["path"] = p.Path
	}
	e.audit(op, map[string]any{"device_id": s.deviceID, "outcome": receipt.Outcome})
	e.reply(s, id, result)
}

func (e *Engine) dispatchLayoutMutation(s *sess, id string, params json.RawMessage, kind string) {
	var (
		session     *string
		operationID string
		paneID      string
		command     runtime.Command
	)
	switch kind {
	case "resize":
		var p struct {
			Session     *string               `json:"session"`
			OperationID string                `json:"operation_id"`
			PaneID      string                `json:"pane_id"`
			Direction   runtime.PaneDirection `json:"direction"`
			Amount      *float64              `json:"amount"`
		}
		if badParams(params, &p) || !validPaneDirection(p.Direction) || (p.Amount != nil && (*p.Amount <= 0 || *p.Amount > 1)) {
			e.replyErr(s, id, "invalid_argument", "invalid pane resize params")
			return
		}
		session, operationID, paneID = p.Session, p.OperationID, p.PaneID
		command = runtime.ResizePaneCommand{PaneID: p.PaneID, Direction: p.Direction, Amount: p.Amount}
	case "swap":
		var p struct {
			Session     *string               `json:"session"`
			OperationID string                `json:"operation_id"`
			PaneID      string                `json:"pane_id"`
			Direction   runtime.PaneDirection `json:"direction"`
		}
		if badParams(params, &p) || !validPaneDirection(p.Direction) {
			e.replyErr(s, id, "invalid_argument", "invalid pane swap params")
			return
		}
		session, operationID, paneID = p.Session, p.OperationID, p.PaneID
		command = runtime.SwapPaneCommand{PaneID: p.PaneID, Direction: p.Direction}
	case "zoom":
		var p struct {
			Session     *string          `json:"session"`
			OperationID string           `json:"operation_id"`
			PaneID      string           `json:"pane_id"`
			Mode        runtime.ZoomMode `json:"mode"`
		}
		if badParams(params, &p) || (p.Mode != runtime.ZoomToggle && p.Mode != runtime.ZoomOn && p.Mode != runtime.ZoomOff) {
			e.replyErr(s, id, "invalid_argument", "invalid pane zoom params")
			return
		}
		session, operationID, paneID = p.Session, p.OperationID, p.PaneID
		command = runtime.ZoomPaneCommand{PaneID: p.PaneID, Mode: p.Mode}
	}
	if invalidSession(session) || !validID(paneID) {
		e.replyErr(s, id, "invalid_argument", "invalid pane layout target")
		return
	}
	receipt, opID, ok := e.executeRPC(s, id, session, operationID, true, command, "pane_not_found")
	if !ok {
		return
	}
	e.audit(kind+"_pane", map[string]any{"device_id": s.deviceID, "pane_id": paneID, "outcome": receipt.Outcome})
	e.reply(s, id, map[string]any{"pane_id": paneID, "operation_id": opID, "outcome": receipt.Outcome})
}

func validPaneDirection(direction runtime.PaneDirection) bool {
	return direction == runtime.PaneLeft || direction == runtime.PaneRight || direction == runtime.PaneUp || direction == runtime.PaneDown
}
