package daemon

import (
	"encoding/json"
	"errors"
	"unicode/utf8"

	"pairfob/internal/runtime"
	"pairfob/internal/workspace"
)

const (
	maxWorkspacePathRunes = workspace.MaxPathRunes
	maxWorkspaceCursor    = 32
)

var workspaceRPCSlots = make(chan struct{}, 4)

type workspacePaneParams struct {
	Session *string `json:"session"`
	PaneID  string  `json:"pane_id"`
}

func validWorkspaceRelativePath(value string, allowEmpty bool) bool {
	return (allowEmpty || value != "") && utf8.ValidString(value) && utf8.RuneCountInString(value) <= maxWorkspacePathRunes
}

func (e *Engine) workspaceRoot(session *string, paneID string) (string, error) {
	snapshot, err := e.snapshot(session)
	if err != nil {
		return "", err
	}
	var pane *runtime.Pane
	for index := range snapshot.Panes {
		if snapshot.Panes[index].PaneID == paneID {
			pane = &snapshot.Panes[index]
			break
		}
	}
	if pane == nil {
		return "", workspace.ErrNotFound
	}
	root := pane.Cwd
	if root == "" {
		for _, item := range snapshot.Workspaces {
			if item.WorkspaceID == pane.WorkspaceID {
				root = item.Cwd
				break
			}
		}
	}
	if !validPath(root) {
		return "", workspace.ErrInvalidPath
	}
	return root, nil
}

func (e *Engine) replyWorkspaceErr(s *sess, id string, err error) {
	switch {
	case errors.Is(err, workspace.ErrInvalidPath):
		e.replyErr(s, id, "forbidden", "workspace path is outside the live pane root")
	case errors.Is(err, workspace.ErrNotFound), errors.Is(err, workspace.ErrNotDirectory):
		e.replyErr(s, id, "workspace_not_found", "workspace target is no longer available")
	case errors.Is(err, workspace.ErrNotRepository):
		e.replyErr(s, id, "unsupported", "this workspace is not a Git repository")
	default:
		e.replyErr(s, id, "internal", "workspace inspection failed")
	}
}

func (e *Engine) dispatchWorkspaceRead(s *sess, id, op string, params json.RawMessage) {
	select {
	case workspaceRPCSlots <- struct{}{}:
		defer func() { <-workspaceRPCSlots }()
	default:
		e.replyErr(s, id, "rate_limited", "too many workspace reads are already running")
		return
	}
	inspector := workspace.NewInspector()
	switch op {
	case "WorkspaceOpen":
		e.rpcWorkspaceOpen(s, id, params, inspector)
	case "WorkspaceList":
		e.rpcWorkspaceList(s, id, params, inspector)
	case "WorkspaceRead":
		e.rpcWorkspaceRead(s, id, params, inspector)
	case "GitStatus":
		e.rpcGitStatus(s, id, params, inspector)
	case "GitDiff":
		e.rpcGitDiff(s, id, params, inspector)
	case "GitBranches":
		e.rpcGitBranches(s, id, params, inspector)
	}
}

func (e *Engine) workspaceTarget(s *sess, id string, p workspacePaneParams) (string, bool) {
	if invalidSession(p.Session) || !validID(p.PaneID) {
		e.replyErr(s, id, "invalid_argument", "invalid workspace pane")
		return "", false
	}
	root, err := e.workspaceRoot(p.Session, p.PaneID)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return "", false
	}
	return root, true
}

func (e *Engine) rpcWorkspaceOpen(s *sess, id string, params json.RawMessage, inspector *workspace.Inspector) {
	var p workspacePaneParams
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "invalid workspace pane")
		return
	}
	root, ok := e.workspaceTarget(s, id, p)
	if !ok {
		return
	}
	descriptor, err := inspector.Describe(root)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, descriptor)
}

func (e *Engine) rpcWorkspaceList(s *sess, id string, params json.RawMessage, inspector *workspace.Inspector) {
	var p struct {
		workspacePaneParams
		Path   string `json:"path"`
		Cursor string `json:"cursor"`
		Limit  int    `json:"limit"`
	}
	if badParams(params, &p) || !validWorkspaceRelativePath(p.Path, true) || len(p.Cursor) > maxWorkspaceCursor || p.Limit < 0 || p.Limit > workspace.MaxListLimit {
		e.replyErr(s, id, "invalid_argument", "invalid workspace directory request")
		return
	}
	root, ok := e.workspaceTarget(s, id, p.workspacePaneParams)
	if !ok {
		return
	}
	page, err := inspector.List(root, p.Path, p.Cursor, p.Limit)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, page)
}

func (e *Engine) rpcWorkspaceRead(s *sess, id string, params json.RawMessage, inspector *workspace.Inspector) {
	var p struct {
		workspacePaneParams
		Path string `json:"path"`
	}
	if badParams(params, &p) || !validWorkspaceRelativePath(p.Path, false) {
		e.replyErr(s, id, "invalid_argument", "invalid workspace file request")
		return
	}
	root, ok := e.workspaceTarget(s, id, p.workspacePaneParams)
	if !ok {
		return
	}
	view, err := inspector.Read(root, p.Path)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, view)
}

func (e *Engine) rpcGitStatus(s *sess, id string, params json.RawMessage, inspector *workspace.Inspector) {
	var p workspacePaneParams
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "invalid Git status request")
		return
	}
	root, ok := e.workspaceTarget(s, id, p)
	if !ok {
		return
	}
	status, err := inspector.Status(root)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, status)
}

func (e *Engine) rpcGitDiff(s *sess, id string, params json.RawMessage, inspector *workspace.Inspector) {
	var p struct {
		workspacePaneParams
		Path  string `json:"path"`
		Layer string `json:"layer"`
	}
	if badParams(params, &p) || !validWorkspaceRelativePath(p.Path, false) || (p.Layer != "worktree" && p.Layer != "staged") {
		e.replyErr(s, id, "invalid_argument", "invalid Git diff request")
		return
	}
	root, ok := e.workspaceTarget(s, id, p.workspacePaneParams)
	if !ok {
		return
	}
	diff, err := inspector.Diff(root, p.Path, p.Layer)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, diff)
}

func (e *Engine) rpcGitBranches(s *sess, id string, params json.RawMessage, inspector *workspace.Inspector) {
	var p workspacePaneParams
	if badParams(params, &p) {
		e.replyErr(s, id, "invalid_argument", "invalid Git branches request")
		return
	}
	root, ok := e.workspaceTarget(s, id, p)
	if !ok {
		return
	}
	branches, err := inspector.Branches(root)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, branches)
}
