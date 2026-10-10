package daemon

import (
	"encoding/json"
	"os"
	"strings"

	"pairfob/internal/workspace"
)

func (e *Engine) rpcWorkspaceResolve(s *sess, id string, params json.RawMessage) {
	var p struct {
		workspacePaneParams
		Root string `json:"root"`
		Path string `json:"path"`
	}
	if badParams(params, &p) || !validWorkspaceRelativePath(p.Path, false) || !validPath(p.Root) {
		e.replyErr(s, id, "invalid_argument", "invalid workspace reference")
		return
	}
	root, ok := e.workspaceTarget(s, id, p.workspacePaneParams)
	if !ok {
		return
	}
	home := ""
	if strings.HasPrefix(p.Path, "~/") {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			e.replyWorkspaceErr(s, id, err)
			return
		}
	}
	result, err := workspace.ResolveReference(root, p.Root, home, p.Path)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return
	}
	e.reply(s, id, result)
}
