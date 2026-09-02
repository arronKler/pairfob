package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

const (
	maxTextBytes   = 32 * 1024
	maxKeys        = 32
	maxReplyText   = 240 * 1024
	maxLabelBytes  = 256
	maxPromptBytes = 4096
)

func (e *Engine) reply(s *sess, id string, result any) bool {
	body, err := json.Marshal(map[string]any{"v": 1, "id": id, "ok": true, "result": result})
	if err != nil || len(body) > aead.MaxPlaintext {
		e.replyErr(s, id, "too_large", "response exceeds protocol limit")
		return false
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	e.mu.Lock()
	active := s.state == "established" && e.sessions[s.routeID] == s && s.s2c != nil
	e.mu.Unlock()
	if !active {
		return false
	}
	payload, err := aead.Seal(s.s2c, s.routeID, body)
	if err != nil {
		return false
	}
	return e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload}) == nil
}

func (e *Engine) replyErr(s *sess, id, code, message string) {
	if utf8.RuneCountInString(message) > 512 {
		message = string([]rune(message)[:512])
	}
	body, err := json.Marshal(map[string]any{
		"v": 1, "id": id, "ok": false,
		"error": map[string]string{"code": code, "message": message},
	})
	if err != nil || len(body) > aead.MaxPlaintext {
		return
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	e.mu.Lock()
	active := s.state == "established" && e.sessions[s.routeID] == s && s.s2c != nil
	e.mu.Unlock()
	if !active {
		return
	}
	payload, err := aead.Seal(s.s2c, s.routeID, body)
	if err == nil {
		_ = e.sendSessionFrame(s, envelope.Frame{Version: 1, Typ: envelope.TypFWD, RouteID: s.routeID, Payload: payload})
	}
}

type sessionParam struct {
	Session *string `json:"session"`
}

func badParams(params json.RawMessage, dst any) bool {
	if len(params) == 0 || len(params) > aead.MaxPlaintext {
		return true
	}
	trimmed := bytes.TrimSpace(params)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return true
	}
	return decodeStrictJSON(params, dst) != nil
}

func decodeStrictJSON(data []byte, dst any) error {
	if !utf8.Valid(data) {
		return errors.New("JSON is not valid UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

var resourceName = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)

func validID(id string) bool { return resourceName.MatchString(id) }

func validRequestID(id string) bool { return id != "" && len(id) <= 128 && utf8.ValidString(id) }

var sessionName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
var operationName = regexp.MustCompile(`^op_[A-Za-z0-9_-]{16,128}$`)
var agentKind = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

func invalidSession(session *string) bool {
	return session != nil && !sessionName.MatchString(*session)
}

func runtimeSession(session *string) runtime.SessionRef {
	if session == nil {
		return runtime.DefaultSession()
	}
	return runtime.NamedSession(*session)
}

func mutationOperationID(explicit, _ string, _ bool) (string, bool) {
	return explicit, operationName.MatchString(explicit)
}

func (e *Engine) snapshot(session *string) (runtime.Snapshot, error) {
	view, err := e.observe(session, runtime.SnapshotQuery{})
	if err != nil {
		return runtime.Snapshot{}, err
	}
	snapshot, ok := view.(runtime.SnapshotView)
	if !ok {
		return runtime.Snapshot{}, errors.New("runtime returned an invalid snapshot view")
	}
	return snapshot.Snapshot, nil
}

func (e *Engine) executeRPC(s *sess, requestID string, session *string, explicitOperationID string, requireOperationID bool, command runtime.Command, notFoundCode string) (runtime.Receipt, string, bool) {
	operationID, ok := mutationOperationID(explicitOperationID, requestID, requireOperationID)
	if !ok {
		e.replyErr(s, requestID, "invalid_argument", "invalid operation_id")
		return runtime.Receipt{}, "", false
	}
	// Keep this deadline in lockstep with pwa MUTATION_RPC_TIMEOUT_MS.
	// CreateConversation includes Herdr agent.start (up to 35s).
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	receipt, err := e.executeMutation(ctx, s.deviceID, runtimeSession(session), operationID, command)
	if err != nil {
		e.replyRuntimeErr(s, requestID, err, notFoundCode)
		return receipt, operationID, false
	}
	return receipt, operationID, true
}

func runtimeCode(err error, notFound string) string {
	if err == nil {
		return ""
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "no such file") || strings.Contains(msg, "connect") || strings.Contains(msg, "eof") || strings.Contains(msg, "timeout") || strings.Contains(msg, "offline") {
		return "herdr_offline"
	}
	if strings.Contains(msg, "multi-session") || strings.Contains(msg, "session name") {
		return "forbidden"
	}
	return notFound
}

func truncateUTF8(text string, limit int) (string, bool) {
	if len(text) <= limit {
		return text, false
	}
	b := []byte(text[:limit])
	for len(b) > 0 && !utf8.Valid(b) {
		b = b[:len(b)-1]
	}
	return string(b), true
}

func validPath(value string) bool {
	return value != "" && utf8.RuneCountInString(value) <= 4096 && utf8.ValidString(value) && filepath.IsAbs(value)
}

func validMaybePath(value string) bool { return value == "" || validPath(value) }

func validOptionalText(value string, limit int) bool {
	return value == "" || (utf8.RuneCountInString(value) <= limit && utf8.ValidString(value))
}

func IsValidHerdrKey(key string) bool {
	_, ok := runtime.CanonicalSendKey(key)
	return ok
}

func (e *Engine) dispatch(s *sess, id, op string, params json.RawMessage) {
	switch op {
	case "Ping":
		e.rpcPing(s, id, params)
	case "GetConfig":
		e.rpcGetConfig(s, id, params)
	case "Snapshot":
		e.rpcSnapshot(s, id, params)
	case "PaneRead":
		e.rpcPaneRead(s, id, params)
	case "SendText":
		e.rpcSendText(s, id, params)
	case "SendKeys":
		e.dispatchSendKeys(s, id, params)
	case "RenamePane":
		e.rpcRenamePane(s, id, params)
	case "RenameTab":
		e.rpcRenameTab(s, id, params)
	case "RenameWorkspace":
		e.rpcRenameWorkspace(s, id, params)
	case "ClosePane":
		e.rpcClosePane(s, id, params)
	case "CloseTab":
		e.rpcCloseTab(s, id, params)
	case "CloseWorkspace":
		e.rpcCloseWorkspace(s, id, params)
	case "CreateConversation":
		e.rpcCreateConversation(s, id, params)
	case "CreateTab":
		e.rpcCreateTab(s, id, params)
	case "SplitPane":
		e.rpcSplitPane(s, id, params)
	case "PromptAgent":
		e.rpcPromptAgent(s, id, params)
	case "ListWorktrees":
		e.rpcListWorktrees(s, id, params)
	case "WorkspaceOpen", "WorkspaceList", "WorkspaceRead", "GitStatus", "GitDiff", "GitBranches":
		go e.dispatchWorkspaceRead(s, id, op, params)
	case "CreateWorktree":
		e.dispatchWorktreeMutation(s, id, params, false)
	case "OpenWorktree":
		e.dispatchWorktreeMutation(s, id, params, true)
	case "ResizePane":
		e.dispatchLayoutMutation(s, id, params, "resize")
	case "SwapPane":
		e.dispatchLayoutMutation(s, id, params, "swap")
	case "ZoomPane":
		e.dispatchLayoutMutation(s, id, params, "zoom")
	case "PushSubscribe":
		e.dispatchPushSubscribe(s, id, params)
	case "RevokeDevice":
		e.rpcRevokeDevice(s, id, params)
	case "ListDevices":
		e.rpcListDevices(s, id, params)
	case "History":
		e.rpcHistory(s, id, params)
	case "AgentTrace":
		e.rpcAgentTrace(s, id, params)
	case "TerminalOpen":
		e.rpcTerminalOpen(s, id, params)
	case "TerminalInput":
		e.rpcTerminalInput(s, id, params)
	case "TerminalResize":
		e.rpcTerminalResize(s, id, params)
	case "TerminalScroll":
		e.rpcTerminalScroll(s, id, params)
	case "TerminalClose":
		e.rpcTerminalClose(s, id, params)
	case "TransportOffer":
		go e.rpcTransportOffer(s, id, params)
	case "TransportCommit":
		e.rpcTransportCommit(s, id, params)
	case "TransportRestart":
		go e.rpcTransportRestart(s, id, params)
	default:
		e.replyErr(s, id, "unknown_op", op)
	}
}

func journalRef(ref *runtime.AgentSessionRef) journal.Ref {
	if ref == nil {
		return journal.Ref{}
	}
	return journal.Ref{Source: ref.Source, Agent: ref.Agent, Kind: ref.Kind, Value: ref.Value}
}

func (e *Engine) findPane(session *string, paneID string) (*runtime.Pane, error) {
	snapshot, err := e.snapshot(session)
	if err != nil {
		return nil, err
	}
	for i := range snapshot.Panes {
		if snapshot.Panes[i].PaneID == paneID {
			return &snapshot.Panes[i], nil
		}
	}
	return nil, nil
}

func receiptEntities(receipt runtime.Receipt) map[string]any {
	result := map[string]any{"outcome": receipt.Outcome}
	for _, entity := range append(append([]runtime.EntityRef{}, receipt.Created...), receipt.Updated...) {
		switch entity.Kind {
		case runtime.EntityWorkspace:
			result["workspace_id"] = entity.ID
		case runtime.EntityTab:
			result["tab_id"] = entity.ID
		case runtime.EntityPane:
			result["pane_id"] = entity.ID
		case runtime.EntityWorktree:
			result["path"] = entity.ID
		}
	}
	return result
}

func (e *Engine) replyRuntimeErr(s *sess, id string, err error, notFound string) {
	code := runtimeCode(err, notFound)
	message := "runtime operation failed"
	if fault, ok := runtime.AsFault(err); ok {
		switch {
		case fault.Outcome == runtime.OutcomePartial:
			code = "partial_failure"
			message = "operation was only partially applied; refresh before taking another action"
		case fault.Outcome == runtime.OutcomeUnknown:
			code = "unknown_outcome"
			message = "operation outcome is unknown; refresh and do not resend it"
		case fault.Code == runtime.CodeUnsupported:
			code = "unsupported"
			message = "operation is unsupported by the live Herdr runtime"
		case fault.Code == runtime.CodeInvalid:
			code = "invalid_argument"
			message = "runtime rejected invalid arguments"
		case fault.Code == runtime.CodeKey:
			code = "invalid_key"
			message = "runtime rejected this key"
		case fault.Code == runtime.CodeNotFound:
			code = notFound
			message = "runtime target is no longer available"
		case fault.Code == runtime.CodeConflict:
			code = "conflict"
			message = "operation conflicts with current runtime state"
		case fault.Code == runtime.CodeBlocked || fault.Code == runtime.CodeNotReady:
			code = "conflict"
			message = "agent is not ready for this operation"
		case fault.Code == runtime.CodeOffline:
			code = "herdr_offline"
			message = "Herdr is offline"
		case fault.Code == runtime.CodeTimeout:
			code = "herdr_offline"
			message = "Herdr did not respond in time"
		case fault.Code == runtime.CodeRateLimited:
			code = "rate_limited"
			message = "runtime rate limit reached"
		case fault.Code == runtime.CodeInternal:
			code = "internal"
			message = "runtime returned an invalid response"
		}
	}
	e.replyErr(s, id, code, message)
}
