package daemon

import (
	"encoding/json"

	"pairfob/internal/workspace"
)

// Bound variants keep legacy RPC fields frozen. The expected root is mandatory;
// handlers choose and validate the live root in the same call that reads data.
func (e *Engine) rpcWorkspaceBound(s *sess, id, op string, params json.RawMessage) {
	var fields map[string]json.RawMessage
	var root string
	var path *string
	if json.Unmarshal(params, &fields) != nil || json.Unmarshal(fields["root"], &root) != nil || !validPath(root) || json.Unmarshal(fields["path"], &path) != nil || path == nil {
		e.replyErr(s, id, "invalid_argument", "expected workspace root is required")
		return
	}
	delete(fields, "root")
	raw, err := json.Marshal(fields)
	if err != nil {
		e.replyErr(s, id, "invalid_argument", "invalid workspace request")
		return
	}
	inspector := workspace.NewInspector()
	switch op {
	case "WorkspaceListAtRoot":
		e.rpcWorkspaceList(s, id, raw, inspector, root)
	case "WorkspaceReadAtRoot":
		e.rpcWorkspaceRead(s, id, raw, inspector, root)
	case "WorkspaceMediaOpenAtRoot":
		e.rpcWorkspaceMediaOpen(s, id, raw, root)
	}
}

func (e *Engine) workspaceReadTarget(s *sess, id string, p workspacePaneParams, expected []string) (string, bool) {
	root, ok := e.workspaceTarget(s, id, p)
	if !ok || len(expected) == 0 {
		return root, ok
	}
	canonical, err := workspace.CanonicalRoot(root)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return "", false
	}
	if canonical != expected[0] {
		e.replyErr(s, id, "conflict", "workspace root changed; reopen the file")
		return "", false
	}
	return canonical, true
}
