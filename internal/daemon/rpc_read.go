package daemon

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/blake2s"

	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

func (e *Engine) rpcPing(s *sess, id string, params json.RawMessage) {
	var p struct {
		Tms *int64 `json:"t_ms"`
	}
	if badParams(params, &p) || p.Tms == nil {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	e.reply(s, id, map[string]any{"t_echo_ms": *p.Tms})
}

func (e *Engine) rpcGetConfig(s *sess, id string, params json.RawMessage) {
	var p struct{}
	if badParams(params, &p) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	descriptor, describeErr := e.RT.Describe(ctx, runtime.DefaultSession())
	cancel()
	capabilities := map[string]bool{
		"create_conversation": descriptor.Supports(runtime.FeatureCreateConversation),
		"create_tab":          descriptor.Supports(runtime.FeatureCreateTab),
		"split_pane":          descriptor.Supports(runtime.FeatureSplitPane),
		"prompt_agent":        descriptor.Supports(runtime.FeaturePromptAgent),
		"history":             describeErr == nil && (e.Journal != nil || descriptor.Supports(runtime.FeaturePaneRead)),
		"list_worktrees":      descriptor.Supports(runtime.FeatureWorktreeList),
		"create_worktree":     descriptor.Supports(runtime.FeatureWorktreeCreate),
		"open_worktree":       descriptor.Supports(runtime.FeatureWorktreeOpen),
		"resize_pane":         descriptor.Supports(runtime.FeatureLayoutResize),
		"swap_pane":           descriptor.Supports(runtime.FeatureLayoutSwap),
		"zoom_pane":           descriptor.Supports(runtime.FeatureLayoutZoom),
	}
	agentKinds := make([]string, 0, len(descriptor.AgentKinds))
	for _, kind := range descriptor.AgentKinds {
		if agentKind.MatchString(kind.Kind) && len(agentKinds) < 32 {
			agentKinds = append(agentKinds, kind.Kind)
		}
	}
	runtimeKind := liveRuntimeKind(e.RuntimeKind(), descriptor, describeErr)
	e.reply(s, id, map[string]any{
		"protocol": 1, "build": "0.1.0", "daemon_id": e.DaemonID, "hostname": e.hostname(),
		"runtime": runtimeKind, "submit_keys": []string{"Enter"}, "vapid_public": e.VAPIDPublic,
		"push_delivery": "webpush",
		"push_enabled":  e.PushEnabled,
		"idle_pause_ms": 30 * 60 * 1000,
		"capabilities":  capabilities,
		"agent_kinds":   agentKinds,
	})
}

func liveRuntimeKind(configured string, descriptor runtime.Descriptor, err error) string {
	if err == nil && descriptor.Runtime != "" {
		return descriptor.Runtime
	}
	if fault, ok := runtime.AsFault(err); ok && (fault.Code == runtime.CodeOffline || fault.Code == runtime.CodeTimeout) {
		return "offline"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "offline"
	}
	return configured
}

func (e *Engine) rpcSnapshot(s *sess, id string, params json.RawMessage) {
	var p sessionParam
	if badParams(params, &p) || invalidSession(p.Session) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	snap, err := e.snapshot(p.Session)
	if err != nil {
		e.replyRuntimeErr(s, id, err, "herdr_offline")
		return
	}
	e.reply(s, id, snap)
}

func (e *Engine) rpcPaneRead(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session *string `json:"session"`
		PaneID  string  `json:"pane_id"`
		Source  string  `json:"source"`
		Format  string  `json:"format"`
		Lines   int     `json:"lines"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) {
		e.replyErr(s, id, "unknown_op", "invalid params")
		return
	}
	if p.Source == "" {
		p.Source = runtime.SourceVisible
	}
	if p.Format == "" {
		p.Format = runtime.FormatANSI
	}
	if p.Source != runtime.SourceVisible {
		e.replyErr(s, id, "forbidden", "only source=visible is allowed")
		return
	}
	if (p.Format != runtime.FormatText && p.Format != runtime.FormatANSI) || p.Lines < 0 || p.Lines > 4096 {
		e.replyErr(s, id, "too_large", "invalid read bounds")
		return
	}
	view, err := e.observe(p.Session, runtime.PaneReadQuery{PaneID: p.PaneID, Source: p.Source, Format: p.Format, Lines: p.Lines})
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	read, ok := view.(runtime.PaneReadView)
	if !ok {
		e.replyErr(s, id, "internal", "runtime returned an invalid pane view")
		return
	}
	text, truncated := read.Text, read.Truncated
	text, clipped := truncateUTF8(text, maxReplyText)
	truncated = truncated || clipped
	sum := blake2s.Sum256([]byte(text))
	e.reply(s, id, map[string]any{"text": text, "truncated": truncated, "hash": hex.EncodeToString(sum[:])})
}

func (e *Engine) rpcHistory(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session *string `json:"session"`
		PaneID  string  `json:"pane_id"`
		Cursor  *string `json:"cursor"`
		Limit   *int    `json:"limit"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) || (p.Cursor != nil && utf8.RuneCountInString(*p.Cursor) > 1024) || (p.Limit != nil && (*p.Limit < 1 || *p.Limit > 200)) {
		e.replyErr(s, id, "invalid_argument", "invalid history params")
		return
	}
	pane, err := e.findPane(p.Session, p.PaneID)
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return
	}
	if pane == nil {
		e.replyErr(s, id, "pane_not_found", "pane is no longer available")
		return
	}
	lines, terminal, cursorErr := terminalHistoryWindow(p.Cursor)
	if cursorErr != nil {
		e.replyErr(s, id, "invalid_argument", "invalid terminal history cursor")
		return
	}
	if terminal {
		e.replyTerminalHistory(s, id, p.Session, p.PaneID, lines)
		return
	}
	ref := journalRef(pane.AgentSession)
	if e.Journal == nil || !e.Journal.Supports(ref) {
		e.replyErr(s, id, "transcript_unavailable", "pane has no supported trusted transcript binding")
		return
	}
	limit := 50
	if p.Limit != nil {
		limit = *p.Limit
	}
	page, err := e.Journal.Read(ref, p.Cursor, limit)
	if err != nil {
		code := "internal"
		switch {
		case errors.Is(err, journal.ErrCursorConflict):
			code = "conflict"
		case errors.Is(err, journal.ErrCursorInvalid):
			code = "invalid_argument"
		case errors.Is(err, journal.ErrUnavailable):
			code = "transcript_unavailable"
		}
		e.replyErr(s, id, code, "history could not be read")
		return
	}
	e.reply(s, id, map[string]any{"items": page.Messages, "next_cursor": page.NextCursor, "truncated": page.Truncated})
}

func (e *Engine) rpcAgentTrace(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session *string `json:"session"`
		PaneID  string  `json:"pane_id"`
		Cursor  *string `json:"cursor"`
		Limit   *int    `json:"limit"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) || (p.Cursor != nil && utf8.RuneCountInString(*p.Cursor) > 1024) || (p.Limit != nil && (*p.Limit < 1 || *p.Limit > 200)) {
		e.replyErr(s, id, "invalid_argument", "invalid agent trace params")
		return
	}
	ref, ok := e.agentTraceRef(s, id, p.Session, p.PaneID)
	if !ok {
		return
	}
	limit := 50
	if p.Limit != nil {
		limit = *p.Limit
	}
	page, err := e.Journal.ReadTrace(ref, p.Cursor, limit)
	if err != nil {
		e.replyAgentTraceError(s, id, err, "agent trace could not be read")
		return
	}
	e.reply(s, id, map[string]any{"items": page.Items, "next_cursor": page.NextCursor, "truncated": page.Truncated})
}

func (e *Engine) rpcAgentTraceSummary(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session *string `json:"session"`
		PaneID  string  `json:"pane_id"`
		Cursor  *string `json:"cursor"`
		Limit   *int    `json:"limit"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) || (p.Cursor != nil && utf8.RuneCountInString(*p.Cursor) > 1024) || (p.Limit != nil && (*p.Limit < 1 || *p.Limit > 200)) {
		e.replyErr(s, id, "invalid_argument", "invalid agent trace summary params")
		return
	}
	ref, ok := e.agentTraceRef(s, id, p.Session, p.PaneID)
	if !ok {
		return
	}
	limit := 50
	if p.Limit != nil {
		limit = *p.Limit
	}
	page, err := e.Journal.ReadTraceSummary(ref, p.Cursor, limit)
	if err != nil {
		e.replyAgentTraceError(s, id, err, "agent trace summary could not be read")
		return
	}
	e.reply(s, id, map[string]any{"items": page.Items, "next_cursor": page.NextCursor, "truncated": page.Truncated})
}

func (e *Engine) rpcAgentTraceDetail(s *sess, id string, params json.RawMessage) {
	var p struct {
		Session   *string `json:"session"`
		PaneID    string  `json:"pane_id"`
		DetailRef string  `json:"detail_ref"`
	}
	if badParams(params, &p) || !validID(p.PaneID) || invalidSession(p.Session) || p.DetailRef == "" || utf8.RuneCountInString(p.DetailRef) > 1024 {
		e.replyErr(s, id, "invalid_argument", "invalid agent trace detail params")
		return
	}
	ref, ok := e.agentTraceRef(s, id, p.Session, p.PaneID)
	if !ok {
		return
	}
	detail, err := e.Journal.ReadTraceDetail(ref, p.DetailRef)
	if err != nil {
		e.replyAgentTraceError(s, id, err, "agent trace detail could not be read")
		return
	}
	e.reply(s, id, detail)
}

func (e *Engine) agentTraceRef(s *sess, id string, session *string, paneID string) (journal.Ref, bool) {
	pane, err := e.findPane(session, paneID)
	if err != nil {
		e.replyRuntimeErr(s, id, err, "pane_not_found")
		return journal.Ref{}, false
	}
	if pane == nil {
		e.replyErr(s, id, "pane_not_found", "pane is no longer available")
		return journal.Ref{}, false
	}
	ref := journalRef(pane.AgentSession)
	if e.Journal == nil || !e.Journal.Supports(ref) {
		e.replyErr(s, id, "transcript_unavailable", "pane has no supported trusted transcript binding")
		return journal.Ref{}, false
	}
	return ref, true
}

func (e *Engine) replyAgentTraceError(s *sess, id string, err error, message string) {
	code := "internal"
	switch {
	case errors.Is(err, journal.ErrCursorConflict):
		code = "conflict"
	case errors.Is(err, journal.ErrCursorInvalid):
		code = "invalid_argument"
	case errors.Is(err, journal.ErrUnavailable):
		code = "transcript_unavailable"
	}
	e.replyErr(s, id, code, message)
}
