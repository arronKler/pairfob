package daemon

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"pairfob/internal/workspace"
)

var mediaHandleName = regexp.MustCompile(mediaHandlePattern)

func (e *Engine) dispatchWorkspaceMedia(s *sess, id, op string, params json.RawMessage) {
	if op == "WorkspaceMediaClose" {
		e.rpcWorkspaceMediaClose(s, id, params)
		return
	}
	select {
	case mediaRPCSlots <- struct{}{}:
		defer func() { <-mediaRPCSlots }()
	default:
		e.replyErr(s, id, "rate_limited", "too many media reads are already running")
		return
	}
	switch op {
	case "WorkspaceMediaOpen":
		e.rpcWorkspaceMediaOpen(s, id, params)
	case "WorkspaceMediaRead":
		e.rpcWorkspaceMediaRead(s, id, params)
	default:
		e.replyErr(s, id, "unknown_op", op)
	}
}

func (e *Engine) replyMediaErr(s *sess, id string, err error) {
	switch {
	case errors.Is(err, workspace.ErrInvalidPath):
		e.replyErr(s, id, "forbidden", "workspace path is outside the live pane root")
	case errors.Is(err, workspace.ErrNotFound), errors.Is(err, workspace.ErrNotDirectory):
		e.replyErr(s, id, "workspace_not_found", "workspace target is no longer available")
	case errors.Is(err, workspace.ErrTooLarge):
		e.replyErr(s, id, "too_large", "file exceeds the media preview size limit")
	case errors.Is(err, workspace.ErrChanged):
		e.replyErr(s, id, "conflict", "the file changed; reopen it")
	case errors.Is(err, workspace.ErrInvalidRange):
		e.replyErr(s, id, "invalid_argument", "invalid media read range")
	case errors.Is(err, errMediaQuota), errors.Is(err, errMediaRate), errors.Is(err, context.DeadlineExceeded):
		e.replyErr(s, id, "rate_limited", err.Error())
	case errors.Is(err, errMediaClosed), errors.Is(err, context.Canceled):
		e.replyErr(s, id, "workspace_not_found", "media session is no longer established")
	default:
		e.replyErr(s, id, "internal", "workspace media failed")
	}
}

func (e *Engine) rpcWorkspaceMediaOpen(s *sess, id string, params json.RawMessage) {
	var p struct {
		workspacePaneParams
		Path string `json:"path"`
	}
	if badParams(params, &p) || !validWorkspaceRelativePath(p.Path, false) {
		e.replyErr(s, id, "invalid_argument", "invalid workspace media request")
		return
	}
	if e.mediaTestEntered != nil {
		e.mediaTestEntered <- struct{}{}
	}
	if e.mediaTestHold != nil {
		<-e.mediaTestHold
	}
	root, ok := e.workspaceTarget(s, id, p.workspacePaneParams)
	if !ok {
		return
	}
	canon, err := workspace.CanonicalRoot(root)
	if err != nil {
		e.replyMediaErr(s, id, err)
		return
	}
	base, err := e.mediaLiveContext(s)
	if err != nil {
		e.replyMediaErr(s, id, err)
		return
	}
	ctx, cancel := context.WithTimeout(base, mediaOpenDeadline)
	defer cancel()
	admit := func(ctx context.Context, n int64) error {
		return e.media.bandwidth.admit(ctx, s, mediaQuotaDisk, n)
	}
	file, err := workspace.NewInspector().OpenMediaContext(ctx, canon, p.Path, admit)
	if err != nil {
		e.replyMediaErr(s, id, err)
		return
	}
	if err := ctx.Err(); err != nil {
		_ = file.Close()
		e.replyMediaErr(s, id, err)
		return
	}
	handleID, err := newMediaHandleID()
	if err != nil {
		_ = file.Close()
		e.replyErr(s, id, "internal", "could not create media handle")
		return
	}
	now := time.Now()
	h := &mediaHandle{
		id: handleID, session: s, rpcSession: p.Session, route: s.routeID, paneID: p.PaneID,
		root: canon, relPath: file.Info().Path, file: file, opened: now,
		deadline: now.Add(mediaHandleIdle),
	}
	if err := e.mediaPut(h); err != nil {
		_ = file.Close()
		e.replyMediaErr(s, id, err)
		return
	}
	info := file.Info()
	if !e.reply(s, id, map[string]any{
		"handle": handleID, "path": info.Path, "kind": info.Kind, "mime": info.MIME,
		"size": info.Size, "modified_ms": info.ModifiedMS, "sha256": info.SHA256,
		"expires_ms": h.deadline.UnixMilli(), "chunk_bytes": workspace.MediaChunkBytes,
		"max_bytes": info.MaxBytes, "max_pixels": workspace.MaxMediaPixels,
		"width": info.Width, "height": info.Height,
	}) {
		if dropped := e.mediaDrop(s, handleID); dropped != nil {
			_ = dropped.file.Close()
		}
	}
}

func (e *Engine) rpcWorkspaceMediaRead(s *sess, id string, params json.RawMessage) {
	// Pointer fields give presence/null awareness: a missing or explicit null
	// offset/length must not silently decode to zero (the schema makes both
	// required integers; the strict decoder alone cannot prove presence).
	var p struct {
		Handle string `json:"handle"`
		Offset *int64 `json:"offset"`
		Length *int64 `json:"length"`
	}
	if badParams(params, &p) || !mediaHandleName.MatchString(p.Handle) {
		e.replyErr(s, id, "invalid_argument", "invalid media read request")
		return
	}
	if p.Offset == nil || p.Length == nil || *p.Offset < 0 ||
		*p.Length < 1 || *p.Length > workspace.MediaChunkBytes {
		e.replyErr(s, id, "invalid_argument", "missing or invalid media read offset/length")
		return
	}
	offset, length := *p.Offset, *p.Length
	h, ok := e.mediaLookup(s, p.Handle)
	if !ok {
		e.replyErr(s, id, "workspace_not_found", "media handle is no longer available")
		return
	}
	// Range bounds before any quota wait, disk read or handle use. offset==size is
	// the legal exact-EOF read; offset>size is out of range. An over-large chunk
	// length is invalid_argument here, not a rate_limited wait.
	size := h.file.Info().Size
	if offset > size {
		e.replyMediaErr(s, id, workspace.ErrInvalidRange)
		return
	}
	if err := e.mediaRevalidate(s, h); err != nil {
		e.replyMediaErr(s, id, err)
		return
	}
	if !h.reading.CompareAndSwap(false, true) {
		e.replyErr(s, id, "rate_limited", "a media chunk is already in flight")
		return
	}
	defer h.reading.Store(false)
	base, err := e.mediaLiveContext(s)
	if err != nil {
		e.replyMediaErr(s, id, err)
		return
	}
	remain := size - offset
	if remain < 0 {
		remain = 0
	}
	want := length
	if want > remain {
		want = remain
	}
	if want > 0 {
		if err := e.media.bandwidth.admit(base, s, mediaQuotaDisk, want); err != nil {
			e.replyMediaErr(s, id, err)
			return
		}
		// Authority after the (possibly sleeping) disk admission: the cwd/pane may
		// have moved, the pane removed, or the handle closed while we waited.
		if err := e.mediaRevalidate(s, h); err != nil {
			e.replyMediaErr(s, id, err)
			return
		}
	}
	chunk, eof, err := h.file.ReadChunk(offset, length)
	if err != nil {
		e.replyMediaErr(s, id, err)
		return
	}
	if cost := mediaNetCost(len(chunk)); cost > 0 {
		if err := e.media.bandwidth.admit(base, s, mediaQuotaNet, cost); err != nil {
			e.replyMediaErr(s, id, err)
			return
		}
		// Authority after the network wait, before a single byte is published.
		if err := e.mediaRevalidate(s, h); err != nil {
			e.replyMediaErr(s, id, err)
			return
		}
	}
	encoded := base64.StdEncoding.EncodeToString(chunk)
	// Final send revalidates ownership inside the send critical section. The full
	// mediaRevalidate (which performs Runtime/Herdr Snapshot I/O for the live root
	// and the file Recheck) already ran after each quota wait above; under the
	// send lock only the bounded in-memory session/handle identity is re-checked,
	// so a Close/retirement that completed while this media reply waited at the
	// interactive-priority gate is caught without blocking other RPCs behind I/O.
	e.replyMediaAuthorized(s, id, map[string]any{
		"handle": h.id, "offset": offset, "length": len(chunk), "bytes": encoded, "eof": eof,
	}, h)
}

func (e *Engine) rpcWorkspaceMediaClose(s *sess, id string, params json.RawMessage) {
	var p struct {
		Handle string `json:"handle"`
	}
	if badParams(params, &p) || !mediaHandleName.MatchString(p.Handle) {
		e.replyErr(s, id, "invalid_argument", "invalid media close request")
		return
	}
	h := e.mediaDrop(s, p.Handle)
	if h != nil && h.session == s {
		_ = h.file.Close()
	}
	e.reply(s, id, map[string]any{"handle": p.Handle, "closed": true})
}

func (e *Engine) mediaRevalidate(s *sess, h *mediaHandle) error {
	// The handle must still be installed for THIS exact session epoch. A live
	// transport is not authority: Close, expiry, route retirement or a replaced
	// session all invalidate in-flight work even while the socket is open.
	e.media.mu.Lock()
	installed := e.media.byHandle[h.id] == h && h.session == s
	e.media.mu.Unlock()
	if !installed {
		return errMediaClosed
	}
	e.mu.Lock()
	live := s.state == "established" && e.sessions[s.routeID] == s
	e.mu.Unlock()
	if !live {
		return errMediaClosed
	}
	// The pane/root the handle was opened for must still be the live one.
	root, err := e.workspaceRoot(h.rpcSession, h.paneID)
	if err != nil {
		return err
	}
	canon, err := workspace.CanonicalRoot(root)
	if err != nil {
		return err
	}
	if canon != h.root {
		return workspace.ErrChanged
	}
	return h.file.Recheck()
}
