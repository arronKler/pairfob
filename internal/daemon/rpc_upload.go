package daemon

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"pairfob/internal/workspace"
)

var (
	uploadSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// uploadMIMEPattern mirrors the PWA strict parser: type/subtype, each a
	// leading ASCII alphanumeric followed by the RFC printable set, both bounded
	// to 64 units. It keeps the server no more permissive than the client.
	uploadMIMEPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$`)
)

// utf16Units reports the UTF-16 code-unit length of s (astral runes count 2),
// matching the unit the PWA strict parsers measure with String.prototype.length.
func utf16Units(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func isControlChar(r rune) bool { return r <= 0x1f || r == 0x7f }

// validDisplayName bounds the client-supplied original file name. It is
// display-only and never becomes a path component, but it must match the PWA
// parser: no control characters and at most uploadMaxNameUnits UTF-16 units.
func validDisplayName(v string) bool {
	if v == "" || !utf8.ValidString(v) {
		return false
	}
	if strings.IndexFunc(v, isControlChar) >= 0 {
		return false
	}
	return utf16Units(v) <= uploadMaxNameUnits
}

// validMime matches the client's strict MIME grammar, is ASCII and at most
// uploadMaxMIMEUnits. It is validated before any staging side effect.
func validMime(v string) bool {
	if v == "" || !utf8.ValidString(v) {
		return false
	}
	if utf16Units(v) > uploadMaxMIMEUnits {
		return false
	}
	return uploadMIMEPattern.MatchString(v)
}

// decodeUploadData decodes canonical standard base64 (alphabet +/, no
// whitespace) and bounds it to one wire chunk of the upload's protocol
// version (32 KiB legacy, 128 KiB V2). The bound is an explicit parameter: it
// is never inferred from the payload size.
func decodeUploadDataBounded(s string, maxChunk int) ([]byte, error) {
	if strings.IndexFunc(s, unicode.IsSpace) >= 0 {
		return nil, errors.New("whitespace in base64")
	}
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(data) > maxChunk {
		return nil, errors.New("chunk too large")
	}
	return data, nil
}

func (e *Engine) uploadRoot(s *sess, id string, p workspacePaneParams) (string, bool) {
	if invalidSession(p.Session) || !validID(p.PaneID) {
		e.replyErr(s, id, "invalid_argument", "invalid upload pane")
		return "", false
	}
	root, err := e.workspaceRoot(p.Session, p.PaneID)
	if err != nil {
		e.replyWorkspaceErr(s, id, err)
		return "", false
	}
	return root, true
}

// bindPhase validates that the caller is the authenticated upload owner AND
// that the current live pane/root/session still equals the immutable binding
// the upload was reserved against. When requireRoot is true it re-resolves the
// authorized live pane and compares the canonical root to the original. Same
// root reached through a different pane is rejected, as is the same pane ID /
// root reached through a different normalized runtime session. Must be called
// before mutating the entry so cached-receipt replays are also bound to the
// same device, pane and session. The caller must not hold entry.mu (fields
// read here are immutable once begin publishes the entry).
func (e *Engine) bindPhase(s *sess, id string, p workspacePaneParams, entry *uploadEntry, requireRoot bool) bool {
	if entry.deviceID != s.deviceID {
		e.replyErr(s, id, "forbidden", "upload is bound to the authenticated device")
		return false
	}
	if entry.sessionName != runtimeSession(p.Session).Name {
		e.replyErr(s, id, "forbidden", "upload is bound to a different runtime session; re-upload in that session")
		return false
	}
	if entry.paneID != p.PaneID {
		e.replyErr(s, id, "forbidden", "upload is bound to a different pane; re-upload under the same pane")
		return false
	}
	if !requireRoot {
		return true
	}
	if !s.liveDevice(e) {
		e.replyErr(s, id, "forbidden", "session is no longer established")
		return false
	}
	root, ok := e.uploadRoot(s, id, p)
	if !ok {
		return false
	}
	canon, err := workspace.CanonicalRoot(root)
	if err != nil {
		e.replyUploadErr(s, id, err)
		return false
	}
	if canon != entry.root {
		e.replyUploadErr(s, id, workspace.ErrChanged)
		return false
	}
	return true
}

// replyUploadErr maps store/validation errors to the frozen wire vocabulary.
func (e *Engine) replyUploadErr(s *sess, id string, err error) {
	switch {
	case errors.Is(err, workspace.ErrInvalidPath):
		e.replyErr(s, id, "forbidden", "attachment path is outside the live pane root")
	case errors.Is(err, workspace.ErrNotFound), errors.Is(err, workspace.ErrNotDirectory):
		e.replyErr(s, id, "workspace_not_found", "workspace upload is no longer available")
	case errors.Is(err, workspace.ErrTooLarge):
		e.replyErr(s, id, "too_large", "upload exceeds the storage limit")
	case errors.Is(err, workspace.ErrInvalidRange):
		e.replyErr(s, id, "invalid_argument", "invalid upload byte range")
	case errors.Is(err, workspace.ErrChanged):
		e.replyErr(s, id, "conflict", "the file or its root changed; reconcile it")
	case errors.Is(err, workspace.ErrConflict), errors.Is(err, errUploadOpReuse):
		e.replyErr(s, id, "conflict", "the upload reference or its final state conflicts")
	case errors.Is(err, workspace.ErrMutationUnknown):
		e.replyErr(s, id, "unknown_outcome", "publish outcome is unknown; do not resend it")
	case errors.Is(err, errUploadReceiptsFull):
		e.replyErr(s, id, "rate_limited", "this upload's operation budget is exhausted")
	default:
		e.replyErr(s, id, "internal", "workspace upload failed")
	}
}

// processUploadRPC validates the common upload frame and runs the named op.
// Every V2 operation routes into the exact same safe handlers with an explicit
// v2=true version parameter; the legacy parser and its 32 KiB bound are
// never loosened.
func (e *Engine) processUploadRPC(s *sess, id, op string, params json.RawMessage) {
	e.processUploadRPCAdmitted(s, id, op, params, uploadV2Admission{})
}

// processUploadRPCAdmitted runs the op with an optional already-performed V2
// admission (ticket / barrier channels). Legacy ops pass a zero admission.
func (e *Engine) processUploadRPCAdmitted(s *sess, id, op string, params json.RawMessage, adm uploadV2Admission) {
	switch op {
	case "WorkspaceUploadBegin":
		e.rpcUploadBegin(s, id, params, false)
	case "WorkspaceUploadBeginV2":
		e.rpcUploadBegin(s, id, params, true)
	case "WorkspaceUploadWrite":
		e.rpcUploadWrite(s, id, params, false, uploadV2Admission{})
	case "WorkspaceUploadWriteV2":
		e.rpcUploadWriteV2(s, id, params, adm)
	case "WorkspaceUploadStatus":
		e.rpcUploadStatus(s, id, params, false, nil)
	case "WorkspaceUploadStatusV2":
		e.rpcUploadStatus(s, id, params, true, adm.chans)
	case "WorkspaceUploadCommit":
		e.rpcUploadCommit(s, id, params, false, nil)
	case "WorkspaceUploadCommitV2":
		e.rpcUploadCommit(s, id, params, true, adm.chans)
	case "WorkspaceUploadCancel":
		e.rpcUploadCancel(s, id, params, false)
	case "WorkspaceUploadCancelV2":
		e.rpcUploadCancel(s, id, params, true)
	default:
		e.replyErr(s, id, "unknown_op", op)
	}
}

func (e *Engine) rpcUploadBegin(s *sess, id string, params json.RawMessage, v2 bool) {
	var p struct {
		workspacePaneParams
		UploadID    string `json:"upload_id"`
		OperationID string `json:"operation_id"`
		Name        string `json:"name"`
		Size        *int64 `json:"size"`
		SHA256      string `json:"sha256"`
		Mime        string `json:"mime"`
	}
	if badParams(params, &p) || !uploadIDPattern.MatchString(p.UploadID) || !operationName.MatchString(p.OperationID) || !validDisplayName(p.Name) || !validMime(p.Mime) || !uploadSHA256Pattern.MatchString(p.SHA256) {
		e.replyErr(s, id, "invalid_argument", "invalid upload begin request")
		return
	}
	if p.Size == nil || *p.Size < 0 || *p.Size > workspace.AttachMaxFileBytes {
		e.replyErr(s, id, "too_large", "file exceeds the per-file upload limit")
		return
	}
	if !s.liveDevice(e) {
		e.replyErr(s, id, "forbidden", "session is no longer established")
		return
	}
	root, ok := e.uploadRoot(s, id, p.workspacePaneParams)
	if !ok {
		return
	}
	canon, err := workspace.CanonicalRoot(root)
	if err != nil {
		e.replyUploadErr(s, id, err)
		return
	}
	used, err := workspace.AttachCompletedBytes(canon)
	if err != nil {
		e.replyUploadErr(s, id, err)
		return
	}
	if used+*p.Size > workspace.AttachCompletedPerRoot {
		e.replyErr(s, id, "too_large", "the workspace attachment quota is full")
		return
	}
	// Reclaim abandoned staging dirs for this root before reserving the new
	// entry, with currently-active server UUIDs exempted so no live stage is
	// removed. Fresh stages here are under the age bound and never selected.
	e.cleanupExpiredStaging(canon)
	// Version binding is part of the begin fingerprint: reusing the same
	// upload_id with a different version is a different (conflicting) begin
	// intent, never a silent version switch on a live upload.
	fingerprint, err := uploadFingerprint("begin", struct {
		Session string `json:"session"`
		PaneID  string `json:"pane_id"`
		Name    string `json:"name"`
		Size    int64  `json:"size"`
		SHA256  string `json:"sha256"`
		Mime    string `json:"mime"`
		V2      bool   `json:"v2"`
	}{runtimeSession(p.Session).Name, p.PaneID, p.Name, *p.Size, p.SHA256, p.Mime, v2})
	if err != nil {
		e.replyErr(s, id, "internal", "could not fingerprint upload begin")
		return
	}
	entry, fresh, wire := e.uploads.begin(s.deviceID, p.UploadID, uploadBeginMeta{
		size: *p.Size, paneID: p.PaneID, root: canon,
		name: p.Name, sha256: p.SHA256, mime: p.Mime, sessionName: runtimeSession(p.Session).Name,
		v2: v2,
	})
	if entry == nil {
		if wire != "" {
			msg := "upload concurrency or quota limit reached"
			if wire == "backpressure" {
				msg = "the daemon upload budget is full; retry later"
			}
			e.replyErr(s, id, wire, msg)
			return
		}
		e.replyErr(s, id, "internal", "could not reserve upload")
		return
	}
	if !fresh {
		// Existing entry: lock it ourselves (a first begin may still be
		// finishing staging and holding the pre-lock; we block until done).
		if !e.bindPhase(s, id, p.workspacePaneParams, entry, true) {
			return
		}
		entry.mu.Lock()
		if e.refuseIfExpired(s, id, entry) {
			entry.mu.Unlock()
			return
		}
		defer entry.mu.Unlock()
		cached, perr, _ := entry.replayOp(p.OperationID, fingerprint)
		if perr != nil {
			e.replyUploadErr(s, id, perr)
			return
		}
		if cached != nil {
			e.reply(s, id, cached)
			return
		}
		e.replyErr(s, id, "conflict", "this upload is already in progress")
		return
	}
	// fresh: begin() published the entry with all immutable metadata and holds
	// entry.mu for us. We finish disk staging and initialization under that
	// lock before it becomes observable outside begin's caller.
	defer entry.mu.Unlock()
	uploadStageGate(entry)
	serverID, serr := newUploadServerID()
	if serr != nil {
		entry.recordOpError(p.OperationID, fingerprint, serr)
		e.abortInit(entry)
		e.replyErr(s, id, "internal", "could not allocate upload staging id")
		return
	}
	stage, serr := workspace.BeginAttachment(canon, serverID, p.Mime, *p.Size)
	if serr != nil {
		entry.recordOpError(p.OperationID, fingerprint, serr)
		e.abortInit(entry)
		e.replyUploadErr(s, id, serr)
		return
	}
	entry.rpcSession = p.Session
	entry.stage = stage
	entry.serverID = serverID
	entry.createdAt = nowFunc()
	entry.expiresAt = entry.createdAt.Add(uploadPendingTTL)
	entry.armExpiry(e)
	result := e.uploadResult(entry)
	entry.recordOpSuccess(p.OperationID, fingerprint, result)
	e.reply(s, id, result)
}

// abortInit settles a freshly-begun entry whose disk staging failed. It marks
// the entry terminal-cancelled, releases its reservation, and records the
// failure so the same begin operation is never re-staged and the reserved
// quota never leaks. Leftover staging directories (no handle survived the
// failure) are reclaimed by the periodic orphan cleanup. The caller holds
// entry.mu.
func (e *Engine) abortInit(entry *uploadEntry) {
	entry.state = uploadStateCancelled
	entry.cancelExpiryTimer()
	e.uploads.settle(entry)
	// A failed Begin never armed a pending timer (createdAt/expiresAt are only
	// assigned after a successful BeginAttachment), so the terminal entry would
	// otherwise linger in byKey forever and repeated failing uploads could fill
	// the 4096-entry registry without ever expiring. Arm the standard 24h
	// terminal-metadata expiry so the record is reaped later without deleting
	// any files. The non-replay failure receipt is preserved (the caller
	// recorded it before calling here) and settlement releases quota exactly
	// once.
	entry.armFinalExpiry(e)
}

// reconcileCommittedLocked verifies an attempted publish for an entry whose
// stage reports Committed() (a rename already happened: either its outcome
// was reported unknown, or a post-rename replacement of the final entry was
// detected). It never renames, writes, publishes or deletes completed files —
// W's ReconcileCommitted retries only the durability fsync. On a durable
// success it transitions the entry to committed exactly once (offset=size and
// final path/name/mime exact), releases the reserved quota once, re-arms the
// terminal metadata expiry, and closes the retained data descriptor. It
// reports one of:
//
//	"committed" -> durable; reply the committed result
//	"unknown"   -> effect occurred but not durably verified; stay pending
//	"conflict"  -> stage did not actually publish; not reconcilable
//
// The caller must hold entry.mu.
func (e *Engine) reconcileCommittedLocked(entry *uploadEntry) (string, map[string]any) {
	if entry.state == uploadStateCommitted {
		return "committed", e.uploadResult(entry)
	}
	stage := entry.stage
	if stage == nil {
		return "conflict", nil
	}
	res, rerr := stage.ReconcileCommitted()
	if rerr == nil {
		entry.state = uploadStateCommitted
		entry.finalRel = res.Rel
		entry.finalPath = filepath.Join(entry.root, filepath.FromSlash(res.Rel))
		entry.offset = entry.size
		_ = stage.Close()
		e.uploads.settle(entry)
		entry.armFinalExpiry(e)
		// Compact chunk receipts to the original uncertain-commit identity so
		// it stays non-reexecuting and D13 terminal-only metadata holds; read-
		// only Status with no daemon mutation identity clears the map.
		entry.preserveTerminalReceipt(entry.publishOpID, entry.publishOpFp)
		return "committed", e.uploadResult(entry)
	}
	if errors.Is(rerr, workspace.ErrMutationUnknown) {
		// Effect occurred but not durably verified (or the current final entry
		// is a foreign replacement that is never deleted). Stay pending.
		return "unknown", nil
	}
	return "conflict", nil
}

// refuseIfExpired is called by a handler that already looked up an entry and
// then acquired entry.mu: if the entry was concurrently tombstoned by expiry
// or shutdown, it replies workspace_not_found (never fabricating a cancelled
// or committed state) and returns true so the caller aborts. The caller holds
// entry.mu.
func (e *Engine) refuseIfExpired(s *sess, id string, entry *uploadEntry) bool {
	if entry.expired {
		e.replyErr(s, id, "workspace_not_found", "upload handle is no longer available")
		return true
	}
	return false
}

func (e *Engine) rpcUploadStatus(s *sess, id string, params json.RawMessage, v2 bool, barrier []chan struct{}) {
	var p struct {
		workspacePaneParams
		UploadID string `json:"upload_id"`
	}
	if badParams(params, &p) || !uploadIDPattern.MatchString(p.UploadID) || invalidSession(p.Session) || !validID(p.PaneID) {
		e.replyErr(s, id, "invalid_argument", "invalid upload status request")
		return
	}
	// V2 barrier: wait bounded for every write ticket admitted BEFORE this
	// Status (captured synchronously in the dispatch path) to settle, BEFORE
	// doing the root/status result. On timeout return unknown_outcome, never
	// a stale success. This is exactly why admission must be synchronous: a
	// write admitted earlier but whose goroutine/root lookup has not started
	// is still in the captured list.
	if v2 && len(barrier) > 0 && !waitChans(barrier, uploadV2WaitLimit) {
		e.replyErr(s, id, "unknown_outcome", "a previously admitted write has not settled")
		return
	}
	entry := e.uploads.lookup(s.deviceID, p.UploadID)
	if entry == nil {
		e.replyErr(s, id, "workspace_not_found", "upload handle is no longer available")
		return
	}
	if !e.bindPhase(s, id, p.workspacePaneParams, entry, true) {
		return
	}
	entry.mu.Lock()
	if e.refuseIfExpired(s, id, entry) {
		entry.mu.Unlock()
		return
	}
	defer entry.mu.Unlock()
	if entry.v2 != v2 {
		e.replyErr(s, id, "conflict", "upload was begun with a different upload protocol version")
		return
	}
	if entry.stage != nil && entry.stage.Committed() {
		// A rename was already attempted; reconcile durability (Status may
		// retry fsync only — never rename/write/publish).
		switch code, result := e.reconcileCommittedLocked(entry); code {
		case "committed":
			e.reply(s, id, result)
		case "unknown":
			// Still pending/unknown; report the current (uploading) state.
			e.reply(s, id, e.uploadResult(entry))
		default:
			e.replyUploadErr(s, id, workspace.ErrConflict)
		}
		return
	}
	e.reply(s, id, e.uploadResult(entry))
}

func (e *Engine) rpcUploadCommit(s *sess, id string, params json.RawMessage, v2 bool, barrier []chan struct{}) {
	var p struct {
		workspacePaneParams
		UploadID    string `json:"upload_id"`
		OperationID string `json:"operation_id"`
	}
	if badParams(params, &p) || !uploadIDPattern.MatchString(p.UploadID) || !operationName.MatchString(p.OperationID) || invalidSession(p.Session) || !validID(p.PaneID) {
		e.replyErr(s, id, "invalid_argument", "invalid upload commit request")
		return
	}
	// CommitV2 uses the same barrier: any newer unresolved admitted work must
	// prevent commit (unknown_outcome on timeout — never commit past a gap).
	if v2 && len(barrier) > 0 && !waitChans(barrier, uploadV2WaitLimit) {
		e.replyErr(s, id, "unknown_outcome", "a previously admitted write has not settled")
		return
	}
	entry := e.uploads.lookup(s.deviceID, p.UploadID)
	if entry == nil {
		e.replyErr(s, id, "workspace_not_found", "upload handle is no longer available")
		return
	}
	if !e.bindPhase(s, id, p.workspacePaneParams, entry, true) {
		return
	}
	entry.mu.Lock()
	if e.refuseIfExpired(s, id, entry) {
		entry.mu.Unlock()
		return
	}
	defer entry.mu.Unlock()
	if entry.v2 != v2 {
		e.replyErr(s, id, "conflict", "upload was begun with a different upload protocol version")
		return
	}
	fingerprint, ferr := uploadFingerprint("commit", struct {
		PaneID string `json:"pane_id"`
	}{p.PaneID})
	if ferr != nil {
		e.replyErr(s, id, "internal", "could not fingerprint upload commit")
		return
	}
	cached, perr, _ := entry.replayOp(p.OperationID, fingerprint)
	if perr != nil {
		e.replyUploadErr(s, id, perr)
		return
	}
	if cached != nil {
		e.reply(s, id, cached)
		return
	}
	if entry.state == uploadStateCommitted {
		e.replyErr(s, id, "conflict", "this upload is already committed")
		return
	}
	if entry.state == uploadStateCancelled || entry.stage == nil {
		e.replyUploadErr(s, id, workspace.ErrConflict)
		return
	}
	if entry.stage.Committed() {
		// A rename was already attempted; never blind-publish a second time.
		// Reconcile the verified current state instead.
		switch code, reResult := e.reconcileCommittedLocked(entry); code {
		case "committed":
			e.reply(s, id, reResult)
		case "unknown":
			e.replyErr(s, id, "unknown_outcome", "publish outcome is unknown; do not resend it")
		default:
			e.replyUploadErr(s, id, workspace.ErrConflict)
		}
		return
	}
	if entry.offset != entry.size {
		e.replyErr(s, id, "conflict", "upload is not complete")
		return
	}
	res, cerr := entry.stage.Commit(entry.size, entry.sha256)
	cerr = commitFault(entry, cerr)
	if cerr == nil {
		entry.state = uploadStateCommitted
		entry.finalRel = res.Rel
		entry.finalPath = filepath.Join(entry.root, filepath.FromSlash(res.Rel))
		entry.offset = entry.size
		// Release the data-file descriptor; the published file is preserved.
		_ = entry.stage.Close()
		e.uploads.settle(entry)
		entry.armFinalExpiry(e)
		result := e.uploadResult(entry)
		entry.finalizeReceipts(p.OperationID, fingerprint, result)
		e.audit("workspace_upload_commit", map[string]any{
			"device_id": s.deviceID, "operation_id": p.OperationID, "path": entry.finalPath,
			"size": entry.size, "sha256": entry.sha256,
		})
		e.reply(s, id, result)
		return
	}
	if errors.Is(cerr, workspace.ErrMutationUnknown) {
		// The rename happened (res.Published may be true or false because a
		// post-rename replacement of the final entry was detected). An effect
		// occurred and must never be reinterpreted as "no effect". Keep the
		// entry logically pending until a Status/Cancel reconciles durability;
		// do NOT abort or delete. Record the non-reexecuting receipt so this
		// commit operation is never re-run, and remember the publish identity so
		// a later reconciliation compacts the receipt map to it.
		entry.recordOpError(p.OperationID, fingerprint, workspace.ErrMutationUnknown)
		entry.publishOpID = p.OperationID
		entry.publishOpFp = fingerprint
		e.replyErr(s, id, "unknown_outcome", "publish outcome is unknown; do not resend it")
		return
	}
	entry.recordOpError(p.OperationID, fingerprint, cerr)
	e.replyUploadErr(s, id, cerr)
}

func sha256hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *sess) liveDevice(e *Engine) bool {
	if s == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return s.state == "established" && e.sessions[s.routeID] == s
}

// nowFunc is a seam so tests can control pending-expiry timers deterministically.
var nowFunc = func() time.Time { return time.Now() }

// uploadStageGate is a deterministic test seam. When configured it is called
// right after an upload entry is published and pre-locked (entry.mu held) but
// before its stamping stage is attached, so a test can drive concurrent
// Status/Cancel/Write and prove they block until initialization completes.
var uploadStageGate = func(_ *uploadEntry) {}

func setUploadStageGate(fn func(*uploadEntry)) func() {
	prev := uploadStageGate
	uploadStageGate = fn
	return func() { uploadStageGate = prev }
}

// commitFault is a deterministic test seam identical-in-effect to W's
// unexported attachErrHook (unreachable from this package). When configured it
// transforms the Commit error right after the REAL stage.Commit ran, so a test
// can force the uncertain-publish branch (and its reconciliation) without
// skipping or stubbing the actual handler or publish path. Production default
// is the identity.
var commitFault = func(_ *uploadEntry, cerr error) error { return cerr }

func setCommitFault(fn func(*uploadEntry, error) error) func() {
	prev := commitFault
	commitFault = fn
	return func() { commitFault = prev }
}
