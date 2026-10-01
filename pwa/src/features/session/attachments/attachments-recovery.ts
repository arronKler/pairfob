/**
 * Durable attachment recovery: native IndexedDB journaling, one-shot restore
 * for the current live scope, and ordered per-row write/delete bookkeeping.
 *
 * Ordering and identity rules:
 * - persist picked / edited / preference-changed / queued rows and the exact
 *   source + upload Files via the native journal library; the full record
 *   (incl. checkpoint) is built synchronously and persisted INSIDE
 *   onCheckpoint before Begin; the hook resolves only after the put settles;
 * - writes and deletes are serialized PER ROW on one tail. A DELETE executes
 *   behind earlier PUTs even when the row is already tombstoned — ONLY puts
 *   self-skip a tombstone, so a terminal/removed row always reaches the
 *   backend, including rows that were never successfully saved;
 * - every daemon/registration carries a monotonic epoch token captured by
 *   queued ops, list-restore and continuations. forgetDaemonAttachments
 *   revokes the token BEFORE its first await: in-flight old-epoch puts
 *   cannot patch state after it, and after the forget completes a NEW epoch
 *   lets a re-paired daemon persist new rows while old callbacks stay dead;
 * - a flush enqueues at most one put per distinct signature: the SAVED,
 *   SCHEDULED (enqueued/in-flight) and FAILED signatures are all remembered,
 *   so progress/timing/phase/warning publications can never multiply Blob
 *   writes or turn a failed save into a retry loop. Only a genuinely new
 *   signature is attempted once more. Signatures compare source/upload FILE
 *   identity, checkpoint identity and meaningful fields — never progress
 *   bytes, timings, the live phase or the warning itself;
 * - after a put settles, the continuation re-validates epoch, tombstone,
 *   row presence, exact File and checkpoint identity before touching saved
 *   signatures or warning state, so an old record can never be mixed with a
 *   newer checkpoint or patch a removed/forgotten/stale row;
 * - a missing / blocked IndexedDB is a real warning, never a silent skip: the
 *   default backend is the REAL native journal and a rejected save/clear
 *   sets a visible persistenceWarning while the upload/forget still settles;
 * - restore lists one pane's records for exactly the CURRENT live authorized
 *   scope/session, re-checked (session/scope/cap AND epoch) after the await,
 *   restores only into non-colliding rows (live rows win), never revives a
 *   tombstoned id, starts no RPC and lets the sheet ask for explicit resume;
 * - forgetComputer clears one daemon's records and local rows after its
 *   credential deletion, preserving every other daemon.
 *
 * This module never performs an upload/RPC and never edits the frozen item in
 * place: the store is the only state authority.
 */
import {
  clearAttachmentRecords,
  deleteAttachmentRecord,
  listAttachmentRecords,
  putAttachmentRecord,
} from "../../../lib/attachment-journal";
import type { AttachmentJournalRecord } from "../../../lib/attachment-journal-codec";
import { liveSession } from "../../computers/catalog-store";
import type { Unsubscribe } from "../../../shared/model/domain-store";
import { attachT } from "./attach-copy";
import {
  scopeMatches,
  uploadFileEnabled,
} from "./attachments-context";
import type {
  AttachmentCheckpoint,
  AttachmentItem,
  AttachmentScope,
} from "./attach-model";
import { attachmentStorageId } from "./attach-model";
import {
  attachmentsStore,
  attachmentScopeKey,
  ensureAttachmentQueue,
  patchItem,
  queueSnapshot,
  removeAttachment,
  restoreAttachmentRecord,
  runtimeCheckpoint,
  runtimeFile,
  runtimeSourceFile,
  setQueueNotice,
} from "./attachments-store";

// --- Journal backend seam (default: real native IndexedDB) -----------------------

export type AttachmentJournalBackend = {
  put(record: AttachmentJournalRecord): Promise<void>;
  list(daemonId: string, paneId: string): Promise<AttachmentJournalRecord[]>;
  remove(daemonId: string, paneId: string, localId: string): Promise<void>;
  clearDaemon(daemonId: string): Promise<void>;
};

const realAttachmentJournal: AttachmentJournalBackend = {
  put: putAttachmentRecord,
  list: listAttachmentRecords,
  remove: deleteAttachmentRecord,
  clearDaemon: clearAttachmentRecords,
};

/**
 * Production uses the REAL journal. Tests inject a fake; passing null
 * restores the real backend. There is deliberately no production environment
 * probe here: a browser without IndexedDB surfaces through the real backend's
 * "unavailable" rejection and becomes a visible warning, not a silent skip.
 */
let journalBackend: AttachmentJournalBackend = realAttachmentJournal;

export function setAttachmentJournalBackend(backend: AttachmentJournalBackend | null): AttachmentJournalBackend {
  journalBackend = backend ?? realAttachmentJournal;
  return journalBackend;
}

/** The currently installed backend (real journal unless a test injected one). */
export function backend(): AttachmentJournalBackend {
  return journalBackend;
}

// --- Epochs, subscriptions and per-row state --------------------------------------

/** Debounce between a queue publication and a persistence flush. */
const FLUSH_DELAY_MS = 300;

type ScopeRegistration = {
  scope: AttachmentScope;
  key: string;
  unsubscribe: Unsubscribe;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

const registrations = new Map<string, ScopeRegistration>();
/** Daemon -> current epoch token; a forget revokes and replaces the token. */
const epochs = new Map<string, number>();
/** Daemons whose forget is in progress; even new-epoch ops must wait. */
const forgetting = new Set<string>();
let epochCounter = 1;

/** Last signature successfully written to the backend for a row. */
const savedSignatures = new Map<string, string>();
/**
 * Currently-scheduled put per row: identity + signature + pending tail. The
 * fresh Symbol identity is the ONLY token that may release the scheduled slot
 * (signature alone can alias two operations with identical Files/CP), and the
 * pending tail lets the before-Begin barrier wait for the actual write.
 */
type ScheduledOp = { sig: string; identity: symbol; tail: Promise<void> };
const scheduledOps = new Map<string, ScheduledOp>();
/** Signature whose last put failed; retried only when the signature changes. */
const failedSignatures = new Map<string, string>();
/** Serial tail per row: writes and deletes for one row never interleave. */
const rowTails = new Map<string, Promise<void>>();
/**
 * Rows whose delete was requested this session. A tombstone blocks late puts
 * and restore resurrection even when the row was never successfully saved;
 * it is removed only by forget (scoped) or full test reset.
 */
const tombstones = new Set<string>();
/** Rows already showing a persistence warning (avoid warning spam). */
const warnedRows = new Set<string>();
/** Stable identity tokens for File objects used inside signatures. */
const fileIds = new WeakMap<File, number>();
let nextFileId = 1;

function fileToken(file: File): number {
  let id = fileIds.get(file);
  if (id === undefined) {
    id = nextFileId;
    nextFileId += 1;
    fileIds.set(file, id);
  }
  return id;
}

function rowId(key: string, localId: string): string {
  return `${key} ${localId}`;
}

function isTerminal(item: AttachmentItem): boolean {
  return item.status === "committed" || item.status === "cancelled";
}

/** Return the scope's current epoch, allocating a token on first use. */
function epochFor(daemonId: string): number {
  let token = epochs.get(daemonId);
  if (token === undefined) {
    token = epochCounter;
    epochCounter += 1;
    epochs.set(daemonId, token);
  }
  return token;
}

/**
 * A captured continuation is live only while its daemon is not being
 * forgotten and still owns the exact epoch token it captured. After a forget
 * completes the token differs forever, so stale callbacks can never land.
 */
function epochValid(daemonId: string | null, token: number): boolean {
  return daemonId !== null
    && !forgetting.has(daemonId)
    && epochs.get(daemonId) === token;
}

/**
 * The fields whose change actually requires a journal write. Progress
 * (acknowledged/speed/ETA/waiting), live transfer phase, measured timings and
 * the persistenceWarning are deliberately ABSENT: they change constantly (or
 * are the result of a failed write) and must not trigger Blob rewrites.
 */
function rowSignature(
  item: AttachmentItem,
  sourceFile: File,
  uploadFile: File,
  checkpoint: AttachmentCheckpoint | null,
): string {
  return JSON.stringify([
    item.status,
    item.cancelIntent,
    item.recoverable,
    item.errorText,
    item.path,
    item.inserted,
    item.editNote,
    item.kind,
    item.name,
    item.size,
    item.mime,
    item.originalBytes,
    item.compressionMode,
    item.imageIntent,
    item.compressionReason,
    item.compressionChanged,
    item.outputWidth,
    item.outputHeight,
    fileToken(sourceFile),
    fileToken(uploadFile),
    checkpointIdentity(checkpoint),
  ]);
}

function checkpointIdentity(checkpoint: AttachmentCheckpoint | null | undefined): string {
  return checkpoint
    ? `${checkpoint.uploadId}|${checkpoint.sha256}|${checkpoint.size}|${checkpoint.version ?? 1}`
    : "";
}

/** Strip live/transient fields: journal rows never carry attempt state. */
function projectItem(item: AttachmentItem): AttachmentItem {
  const {
    speedBps: _speedBps,
    etaSeconds: _etaSeconds,
    waiting: _waiting,
    stageTimings: _stageTimings,
    persistenceWarning: _persistenceWarning,
    restored: _restored,
    scheduled: _scheduled,
    transferPhase: _transferPhase,
    compressing: _compressing,
    acknowledged: _acknowledged,
    ...rest
  } = item;
  return { ...rest, acknowledged: 0, scheduled: false, transferPhase: undefined, compressing: false };
}

function warnPersistenceFailure(key: string, localId: string): void {
  const rid = rowId(key, localId);
  if (warnedRows.has(rid)) return;
  warnedRows.add(rid);
  patchItem(key, localId, { persistenceWarning: attachT("attach.persistenceFailed") });
}

function clearPersistenceWarning(key: string, localId: string): void {
  const rid = rowId(key, localId);
  if (!warnedRows.has(rid)) return;
  warnedRows.delete(rid);
  patchItem(key, localId, { persistenceWarning: "" });
}

// --- Per-row serialized tails -----------------------------------------------------

type RowOperation =
  | {
      kind: "put";
      token: number;
      /** Fresh per-operation identity captured at enqueue; never a bare signature. */
      identity: symbol;
      record: AttachmentJournalRecord;
      signature: string;
    }
  | { kind: "delete"; token: number };

/**
 * Serialize one operation behind the row's earlier operations. Epoch applies
 * to BOTH kinds; the tombstone self-skip applies to PUTS ONLY — a delete must
 * still execute behind the puts it follows.
 */
function enqueueRowOp(
  scope: AttachmentScope,
  localId: string,
  operation: RowOperation,
): Promise<void> {
  const daemonId = scope.daemonId;
  const key = attachmentScopeKey(scope);
  const rid = rowId(key, localId);
  const previous = rowTails.get(rid) ?? Promise.resolve();
  const run = previous
    .then(async () => {
      if (!epochValid(daemonId, operation.token)) return;
      if (operation.kind === "put") {
        if (tombstones.has(rid)) return; // its ordered delete follows
        await executePut(key, scope, localId, operation.token, operation.identity, operation.record, operation.signature);
      } else {
        await executeDelete(key, scope, localId, operation.token);
      }
    })
    .catch(() => {
      // Every concrete operation contains its own storage failure; this is
      // last-resort containment so the per-row tail never dies.
    });
  rowTails.set(rid, run);
  void run.finally(() => {
    if (rowTails.get(rid) === run) rowTails.delete(rid);
  });
  return run;
}

type BuiltPut =
  | { kind: "put"; record: AttachmentJournalRecord; signature: string }
  | { kind: "delete" }
  | null;

/**
 * Snapshot the CURRENT row state synchronously. The record and signature are
 * captured NOW, so after the serialized await the continuation never combines
 * an older item/File snapshot with a newer runtime checkpoint.
 */
function buildPut(scope: AttachmentScope, localId: string): BuiltPut {
  const daemonId = scope.daemonId;
  if (!daemonId) return null;
  const key = attachmentScopeKey(scope);
  const rid = rowId(key, localId);
  if (tombstones.has(rid)) return null;
  const item = queueSnapshot(key)?.items.find((candidate) => candidate.localId === localId) ?? null;
  const sourceFile = runtimeSourceFile(key, localId);
  const uploadFile = runtimeFile(key, localId);
  if (!item || !sourceFile || !uploadFile) return null;
  if (isTerminal(item)) return { kind: "delete" };
  const checkpoint = runtimeCheckpoint(key, localId) ?? undefined;
  const record: AttachmentJournalRecord = {
    version: 1,
    daemonId: attachmentStorageId(scope),
    paneId: scope.paneId,
    localId,
    updatedAt: Date.now(),
    sourceFile,
    uploadFile,
    item: projectItem(item),
    checkpoint,
  };
  return {
    kind: "put",
    record,
    signature: rowSignature(item, sourceFile, uploadFile, checkpoint ?? null),
  };
}

/**
 * Release the scheduled-put slot ONLY when this exact operation identity is
 * still the currently scheduled one for the row. Two queued puts can share the
 * SAME signature (identical Files/CP after a revert), so the signature alone
 * must never release the slot — only the fresh Symbol identity and the current
 * epoch may. Returns the released pending tail for the barrier caller, or null
 * when the slot moved on.
 */
function releaseScheduledOp(rid: string, identity: symbol): Promise<void> | null {
  const current = scheduledOps.get(rid);
  if (!current || current.identity !== identity) return null;
  scheduledOps.delete(rid);
  return current.tail;
}

/**
 * Enqueue a put for the current row state unless it is already saved, already
 * scheduled, already failed at exactly this signature, tombstoned or being
 * forgotten. Resolves once the serialized put settles. When a put with the SAME
 * signature is already enqueued/in flight, returns that operation's actual
 * pending tail so the before-Begin barrier cannot resolve while the matching
 * write is still pending (one Blob write, both awaiting callers wait for it).
 *
 * savedSignatures/failedSignatures are only trustworthy while NO conflicting
 * scheduled write is pending: a parked put B may still land on disk and
 * overwrite a signature that saved/failed claims to represent, so a revert to
 * that signature must queue its own put BEHIND B rather than be deduped away.
 */
function enqueuePut(scope: AttachmentScope, localId: string): Promise<void> {
  const daemonId = scope.daemonId;
  if (!daemonId) return Promise.resolve();
  const key = attachmentScopeKey(scope);
  const rid = rowId(key, localId);
  if (forgetting.has(daemonId) || tombstones.has(rid)) return Promise.resolve();
  const built = buildPut(scope, localId);
  if (!built) return Promise.resolve();
  if (built.kind === "delete") return requestRowDelete(scope, localId);
  const scheduled = scheduledOps.get(rid);
  // A matching put is already scheduled: wait on ITS tail, not a fresh resolve.
  if (scheduled && scheduled.sig === built.signature) {
    return scheduled.tail;
  }
  // saved/failed dedup only applies when no CONFLICTING scheduled put exists. A
  // pending put B with a different signature could still land on disk and
  // overwrite the row, so a revert to a saved/failed signature must still queue
  // its own put behind B (ABA fix 2).
  const dedup = savedSignatures.get(rid) === built.signature
    || failedSignatures.get(rid) === built.signature;
  if (dedup && !scheduled) {
    return Promise.resolve();
  }
  const identity = Symbol("recovery-put");
  const putTail = enqueueRowOp(scope, localId, {
    kind: "put",
    token: epochFor(daemonId),
    identity,
    record: built.record,
    signature: built.signature,
  });
  scheduledOps.set(rid, { sig: built.signature, identity, tail: putTail });
  return putTail;
}

/**
 * The row still represents exactly the captured record: present, non-terminal,
 * same source/upload File objects and same checkpoint identity. Checked after
 * every backend await before any signature or warning patch.
 */
function recordStillCurrent(
  key: string,
  localId: string,
  record: AttachmentJournalRecord,
): boolean {
  const item = queueSnapshot(key)?.items.find((candidate) => candidate.localId === localId) ?? null;
  if (!item || isTerminal(item)) return false;
  if (runtimeSourceFile(key, localId) !== record.sourceFile) return false;
  if (runtimeFile(key, localId) !== record.uploadFile) return false;
  if (checkpointIdentity(runtimeCheckpoint(key, localId) ?? undefined) !== checkpointIdentity(record.checkpoint)) {
    return false;
  }
  return true;
}

async function executePut(
  key: string,
  scope: AttachmentScope,
  localId: string,
  token: number,
  identity: symbol,
  record: AttachmentJournalRecord,
  signature: string,
): Promise<void> {
  const daemonId = scope.daemonId;
  const rid = rowId(key, localId);
  try {
    await journalBackend.put(record);
  } catch {
    // Release ONLY the scheduled slot this exact operation identity owns, and
    // only after the epoch/tombstone guards: an earlier A finishing while a
    // later B is scheduled must never delete B's slot, and an old-epoch A
    // finishing after a reset must never erase the new epoch's marker. On a
    // still-current row the failure is visible and remembered, so
    // warning-driven flushes cannot retry the SAME bytes — only a genuinely new
    // signature gets one attempt.
    if (epochValid(daemonId, token) && !tombstones.has(rid)) {
      releaseScheduledOp(rid, identity);
      if (recordStillCurrent(key, localId, record)) {
        failedSignatures.set(rid, signature);
        warnPersistenceFailure(key, localId);
      }
    }
    return;
  }
  // Post-await guards: never attribute this record to a moved-on row and
  // never patch bookkeeping/warnings for forgotten or stale continuations.
  if (!epochValid(daemonId, token) || tombstones.has(rid)) return;
  if (!recordStillCurrent(key, localId, record)) return;
  // Clear the slot only if this EXACT operation is still the scheduled one —
  // never a newer put that replaced it (ABA fix 1).
  releaseScheduledOp(rid, identity);
  failedSignatures.delete(rid);
  savedSignatures.set(rid, signature);
  clearPersistenceWarning(key, localId);
}

async function executeDelete(
  key: string,
  scope: AttachmentScope,
  localId: string,
  token: number,
): Promise<void> {
  const daemonId = scope.daemonId;
  try {
    await journalBackend.remove(attachmentStorageId(scope), scope.paneId, localId);
  } catch {
    // The local row is already gone; surface the failed cleanup honestly in
    // the pane notice instead of dropping the rejection on the floor, but
    // never patch a forgotten/stale scope.
    if (!epochValid(daemonId, token)) return;
    ensureAttachmentQueue(key);
    setQueueNotice(key, attachT("attach.persistenceFailed"));
  }
}

/** Debounced flush of every row in one scope whose signature changed. */
function flushScope(key: string): void {
  const registration = registrations.get(key);
  if (!registration) return;
  const { scope } = registration;
  if (!scope.daemonId || forgetting.has(scope.daemonId)) return;
  const items = queueSnapshot(key)?.items ?? [];
  const alive = new Set<string>();
  for (const item of items) {
    alive.add(item.localId);
    // Terminal rows become an ordered delete; missing runtime is skipped.
    void enqueuePut(scope, item.localId);
  }
  // Rows that vanished (removal) get an ordered delete even when their only
  // trace is a scheduled/failed (never-saved) put: union all signature maps.
  const known = new Set<string>([
    ...savedSignatures.keys(),
    ...scheduledOps.keys(),
    ...failedSignatures.keys(),
  ]);
  const prefix = `${key} `;
  for (const rid of known) {
    if (!rid.startsWith(prefix)) continue;
    const localId = rid.slice(prefix.length);
    if (alive.has(localId)) continue;
    void requestRowDelete(scope, localId);
  }
}

function scheduleFlush(key: string): void {
  const registration = registrations.get(key);
  if (!registration || registration.flushTimer !== null) return;
  registration.flushTimer = setTimeout(() => {
    registration.flushTimer = null;
    flushScope(key);
  }, FLUSH_DELAY_MS);
}

/**
 * Register a live scope for persistence and restore. Idempotent per scope
 * key. A null daemon id is the only excluded scope (no journal identity).
 * The store subscription survives the sheet closing: uploads continue and
 * queued rows stay durable even when no UI is mounted.
 */
export function registerAttachmentScope(scope: AttachmentScope): void {
  if (!scope.daemonId) return;
  const key = attachmentScopeKey(scope);
  if (registrations.has(key)) return;
  epochFor(scope.daemonId);
  const registration: ScopeRegistration = {
    scope,
    key,
    unsubscribe: attachmentsStore.subscribe(() => scheduleFlush(key)),
    flushTimer: null,
  };
  registrations.set(key, registration);
}

// --- Explicit controller hooks ----------------------------------------------------

/**
 * Persist the exact source/upload/item/checkpoint record NOW, through the
 * per-row tail (ordered behind any earlier write). Called by the transfer's
 * onCheckpoint BEFORE Begin; never rejects — a storage failure is warned on
 * the row but deliberately does not block the upload.
 */
export function persistAttachmentCheckpoint(scope: AttachmentScope, localId: string): Promise<void> {
  return enqueuePut(scope, localId);
}

/** Enqueue an immediate (non-awaited) flush — e.g. a cancel intent. */
export function scheduleAttachmentPersist(scope: AttachmentScope, localId: string): void {
  void enqueuePut(scope, localId);
}

/**
 * Ordered journal delete for a committed/cancelled/removed row. The tombstone
 * is recorded FIRST and unconditionally, so every later queued put self-skips
 * and a list-restore can never revive the id. The DELETE itself is enqueued
 * behind prior puts and is never skipped. Repeated calls enqueue at most one
 * backend remove.
 */
export function requestRowDelete(scope: AttachmentScope, localId: string): Promise<void> {
  const daemonId = scope.daemonId;
  if (!daemonId) return Promise.resolve();
  const key = attachmentScopeKey(scope);
  const rid = rowId(key, localId);
  const alreadyTombstoned = tombstones.has(rid);
  tombstones.add(rid);
  savedSignatures.delete(rid);
  scheduledOps.delete(rid);
  failedSignatures.delete(rid);
  if (alreadyTombstoned) return rowTails.get(rid) ?? Promise.resolve();
  return enqueueRowOp(scope, localId, { kind: "delete", token: epochFor(daemonId) });
}

/**
 * Restore one pane's journal rows into the live store for the CURRENT live,
 * authorized scope/session only. Captures the session and registration
 * epoch, lists, then re-checks ownership AND epoch after the await. Restores
 * no row that collides with a live one (live rows win), revives no
 * tombstoned id, starts no RPC and never auto-uploads; the caller's sheet
 * offers explicit resume for checkpoint rows. Returns the number restored.
 */
export async function restoreAttachmentScope(scope: AttachmentScope): Promise<number> {
  const daemonId = scope.daemonId;
  if (!daemonId) return 0;
  const key = attachmentScopeKey(scope);
  registerAttachmentScope(scope);
  const token = epochFor(daemonId);
  if (forgetting.has(daemonId)) return 0;
  const session = liveSession();
  if (!session || !scopeMatches(scope) || !uploadFileEnabled()) return 0;
  let records: AttachmentJournalRecord[];
  try {
    records = await journalBackend.list(attachmentStorageId(scope), scope.paneId);
  } catch {
    // Missing/blocked storage or a read failure: nothing to restore. SAVE
    // failures (if the user uploads) still produce the visible warning.
    return 0;
  }
  // Re-gate after the await with the EXACT session captured above AND the
  // registration epoch captured before the list.
  if (!epochValid(daemonId, token)) return 0;
  if (!scopeMatches(scope) || liveSession() !== session || !uploadFileEnabled()) return 0;
  let restored = 0;
  for (const record of records) {
    if (record.daemonId !== attachmentStorageId(scope) || record.paneId !== scope.paneId) continue;
    if (tombstones.has(rowId(key, record.localId))) continue;
    if (!restoreAttachmentRecord(record, scope)) continue;
    restored += 1;
    // The restored bytes ARE the durable state: remember their signature so a
    // subscription publish does not immediately rewrite the same Blobs.
    const item = queueSnapshot(key)?.items.find((candidate) => candidate.localId === record.localId);
    const sourceFile = runtimeSourceFile(key, record.localId);
    const uploadFile = runtimeFile(key, record.localId);
    if (item && sourceFile && uploadFile) {
      const rid = rowId(key, record.localId);
      savedSignatures.set(
        rid,
        rowSignature(item, sourceFile, uploadFile, runtimeCheckpoint(key, record.localId)),
      );
      scheduledOps.delete(rid);
      failedSignatures.delete(rid);
    }
  }
  if (restored > 0) {
    ensureAttachmentQueue(key);
    setQueueNotice(key, attachT("attach.restoredUnfinished"));
  }
  return restored;
}

/**
 * Forget one daemon AFTER its credential deletion. The epoch is revoked and
 * the in-progress mark is set BEFORE any await, so in-flight writes discard
 * themselves; pending per-row tails are drained before exactly that daemon's
 * IndexedDB records are cleared (other daemons untouched) and its local rows
 * are dropped without any server RPC. A clear FAILURE is surfaced on the
 * daemon's queues (never a silent durable-cleanup claim); either way the new
 * epoch stays valid so a future re-pair can persist brand-new rows while old
 * captured callbacks remain revoked.
 */
export async function forgetDaemonAttachments(daemonId: string): Promise<void> {
  if (!daemonId) return;
  // Revoke before the first await: old-epoch continuations die here, and no
  // op (even one carrying the fresh token) may run while forgetting.
  forgetting.add(daemonId);
  epochCounter += 1;
  epochs.set(daemonId, epochCounter);

  const owned = [...registrations.values()].filter((registration) => registration.scope.daemonId === daemonId);
  const pending: Promise<void>[] = [];
  for (const registration of owned) {
    if (registration.flushTimer !== null) {
      clearTimeout(registration.flushTimer);
      registration.flushTimer = null;
    }
    registration.unsubscribe();
    const prefix = `${registration.key} `;
    for (const [rid, tail] of rowTails) {
      if (rid.startsWith(prefix)) pending.push(tail);
    }
  }
  // Old-epoch ops self-discard; drain so none can land after the clear.
  await Promise.all(pending.map((tail) => tail.catch(() => undefined)));

  let clearFailed = false;
  try {
    await journalBackend.clearDaemon(daemonId);
  } catch {
    clearFailed = true; // surfaced after local cleanup; credentials are gone
  }

  const ownedKeys = owned.map((registration) => registration.key);
  for (const registration of owned) {
    const { key } = registration;
    for (const item of queueSnapshot(key)?.items ?? []) {
      removeAttachment(key, item.localId);
    }
    registrations.delete(key);
  }
  for (const key of ownedKeys) {
    const prefix = `${key} `;
    for (const rid of [
      ...tombstones,
      ...warnedRows,
      ...savedSignatures.keys(),
      ...scheduledOps.keys(),
      ...failedSignatures.keys(),
      ...rowTails.keys(),
    ]) {
      if (!rid.startsWith(prefix)) continue;
      tombstones.delete(rid);
      warnedRows.delete(rid);
      savedSignatures.delete(rid);
      scheduledOps.delete(rid);
      failedSignatures.delete(rid);
      rowTails.delete(rid);
    }
  }
  // New rows for a re-paired daemon are allowed from now on; only callbacks
  // that captured a pre-forget epoch remain revoked.
  forgetting.delete(daemonId);
  if (clearFailed) {
    for (const key of ownedKeys) {
      ensureAttachmentQueue(key);
      setQueueNotice(key, attachT("attach.persistenceFailed"));
    }
  }
}

/**
 * Test teardown: unsubscribe, cancel timers, revoke every epoch (in-flight
 * continuations then fail all post-await guards and cannot warn into a fresh
 * test), clear bookkeeping, and restore the real journal backend.
 */
export function resetAttachmentRecovery(): void {
  epochCounter += 1; // invalidate every token captured before the reset
  for (const registration of registrations.values()) {
    if (registration.flushTimer !== null) clearTimeout(registration.flushTimer);
    registration.unsubscribe();
  }
  registrations.clear();
  epochs.clear();
  forgetting.clear();
  savedSignatures.clear();
  scheduledOps.clear();
  failedSignatures.clear();
  rowTails.clear();
  tombstones.clear();
  warnedRows.clear();
  journalBackend = realAttachmentJournal;
}

/**
 * Test-only deterministic barrier: run every registered scope's pending
 * debounced flush immediately and flush the microtask queue a bounded number
 * of ticks so operations reach their first backend await, WITHOUT waiting for
 * blocked tails. Tests use it while a journal gate is parked; production never
 * calls this.
 */
export async function __pumpAttachmentRecovery(ticks = 10): Promise<void> {
  for (const registration of registrations.values()) {
    if (registration.flushTimer !== null) {
      clearTimeout(registration.flushTimer);
      registration.flushTimer = null;
    }
    flushScope(registration.key);
  }
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  // A second pass lets transitions observed after the first flush enqueue
  // (e.g. a vanished-row delete) without waiting on any parked tail.
  for (const registration of registrations.values()) flushScope(registration.key);
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

/**
 * Test-only deterministic barrier: pump, then wait until all per-row tails
 * have settled, with one more bounded pass so terminal/vanished transitions
 * reach the backend too. Only valid once parked journal gates are resolved.
 * Production never calls this.
 */
export async function __settleAttachmentRecovery(): Promise<void> {
  await __pumpAttachmentRecovery();
  await Promise.all([...rowTails.values()].map((tail) => tail.catch(() => undefined)));
  await __pumpAttachmentRecovery();
  await Promise.all([...rowTails.values()].map((tail) => tail.catch(() => undefined)));
}
