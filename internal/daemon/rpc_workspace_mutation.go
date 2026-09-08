package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"pairfob/internal/runtime"
	"pairfob/internal/workspace"
)

type workspaceFileMutation struct {
	workspacePaneParams
	Revision    string `json:"revision"`
	OperationID string `json:"operation_id"`
	Root        string `json:"root"`
	Path        string `json:"path"`
	Size        *int64 `json:"size"`
	ModifiedMS  *int64 `json:"modified_ms"`
}

func (e *Engine) rpcWorkspaceMutation(s *sess, id, op string, params json.RawMessage) {
	var p workspaceFileMutation
	var newName string
	rename := op == "WorkspaceRename"
	var invalidParams bool
	if rename {
		var request struct {
			workspaceFileMutation
			NewName string `json:"new_name"`
		}
		invalidParams = badParams(params, &request)
		p, newName = request.workspaceFileMutation, request.NewName
	} else {
		invalidParams = badParams(params, &p)
	}
	if invalidParams || len(p.Revision) != 64 || invalidSession(p.Session) || !validID(p.PaneID) || !operationName.MatchString(p.OperationID) || !validPath(p.Root) || !validWorkspaceRelativePath(p.Path, false) || p.Size == nil || *p.Size < 0 || p.ModifiedMS == nil || (rename && !validWorkspaceRelativePath(newName, false)) {
		e.replyErr(s, id, "invalid_argument", "invalid file operation")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	intent := struct {
		Op      string
		Params  workspaceFileMutation
		NewName string
	}{op, p, newName}
	receipt, err := e.executeTrackedMutation(ctx, s.deviceID, runtimeSession(p.Session), p.OperationID, intent, func() (runtime.Receipt, error) {
		descriptor, describeErr := e.RT.Describe(ctx, runtime.DefaultSession())
		if describeErr != nil {
			return runtime.Receipt{}, describeErr
		}
		if !descriptor.Supports(runtime.FeatureSnapshot) {
			return runtime.Receipt{}, &runtime.Fault{Code: runtime.CodeUnsupported, Outcome: runtime.OutcomeNotApplied, Retry: runtime.RetryNever}
		}
		root, rootErr := e.workspaceRoot(p.Session, p.PaneID)
		if rootErr != nil {
			return runtime.Receipt{}, fileMutationFault(rootErr)
		}
		mutationErr := workspace.MutateFile(root, p.Root, p.Path, newName, p.Revision, *p.Size, *p.ModifiedMS, rename)
		if mutationErr != nil {
			return runtime.Receipt{}, fileMutationFault(mutationErr)
		}
		return runtime.Receipt{Outcome: runtime.OutcomeApplied}, nil
	})
	if err != nil {
		e.replyRuntimeErr(s, id, err, "workspace_not_found")
		return
	}
	e.audit(op, map[string]any{"device_id": s.deviceID, "operation_id": p.OperationID, "outcome": receipt.Outcome})
	e.reply(s, id, map[string]any{"operation_id": p.OperationID, "outcome": receipt.Outcome})
}

func fileMutationFault(err error) error {
	if errors.Is(err, workspace.ErrMutationUnknown) {
		return unknownOperationFault(err)
	}
	code := runtime.CodeInternal
	switch {
	case errors.Is(err, workspace.ErrInvalidPath), errors.Is(err, os.ErrPermission):
		code = runtime.CodeInvalid
	case errors.Is(err, workspace.ErrConflict), errors.Is(err, os.ErrExist):
		code = runtime.CodeConflict
	case errors.Is(err, workspace.ErrNotFound), errors.Is(err, os.ErrNotExist):
		code = runtime.CodeNotFound
	}
	return &runtime.Fault{Code: code, Outcome: runtime.OutcomeNotApplied, Retry: runtime.RetryNever, Cause: err}
}
