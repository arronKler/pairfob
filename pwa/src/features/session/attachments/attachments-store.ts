/**
 * Per-pane attachment queues.
 *
 * The domain record is plain, frozen, subscribable state for React. Anything
 * browser-lived (the picked `File`, its object URL, the in-flight
 * `AbortController`, the upload checkpoint) stays in a module-side runtime
 * table keyed by the same local id. That keeps the published snapshot deep
 * frozen while uploads continue after the sheet closes.
 *
 * Queues are scoped by (daemon id, Herdr session, pane id): switching panes or modes never
 * mutates another pane's list, and mode switches inside one pane share it.
 */
import { createDomain } from "../../../shared/model/domain-store";
import {
  attachmentStorageId,
  isImageMeta,
  isPhotoOrigin,
  metaFromFile,
  type AttachmentCheckpoint,
  type AttachmentImageIntent,
  type AttachmentItem,
  type AttachmentKind,
  type AttachmentQueue,
  type AttachmentScope,
  type AttachmentStatus,
  type CompressionReason,
  type IncomingMeta,
} from "./attach-model";
import { requestThumbnail } from "./attachments-thumbnails";
// Type-only: the journal codec imports only types back from this feature.
import type { AttachmentJournalRecord } from "../../../lib/attachment-journal-codec";

export type { AttachmentScope } from "./attach-model";

export function attachmentScopeKey(scope: AttachmentScope): string {
  return `${attachmentStorageId(scope)} ${scope.paneId}`;
}

type AttachmentsRecord = {
  queues: Record<string, AttachmentQueue>;
};

const attachmentsDomain = createDomain<AttachmentsRecord>("attachments", { queues: {} });
export const attachmentsStore = attachmentsDomain.store;
const { read, write } = attachmentsDomain.controller;

export function queueSnapshot(key: string): AttachmentQueue | undefined {
  return read().queues[key];
}

export function publishedQueue(key: string): AttachmentQueue | undefined {
  return attachmentsStore.get().queues[key];
}

function withQueue<T>(key: string, mutate: (queue: AttachmentQueue) => T): T | undefined {
  let result: T | undefined;
  write((record) => {
    const queue = record.queues[key];
    if (queue) result = mutate(queue);
  });
  return result;
}

function replaceItems(queue: AttachmentQueue, items: readonly AttachmentItem[], notice?: string): void {
  const mutable = queue as unknown as { items: AttachmentItem[]; notice: string };
  mutable.items = [...items];
  if (notice !== undefined) mutable.notice = notice;
}

export function resetAttachmentQueues(): void {
  for (const [key, queue] of Object.entries(read().queues)) {
    for (const item of queue.items) dropRuntime(key, item.localId);
  }
  write((record) => {
    record.queues = {};
  });
}

/** Browser-lived parts of one attachment that never enter the frozen snapshot. */

/** Cached core prepare result for one source revision; cleared on edit. */
export type PreparedImage = {
  file: File;
  reason: CompressionReason;
  originalBytes: number;
  changed: boolean;
  /** Pixel dimensions of the prepared file when the pipeline reports them. */
  width?: number;
  height?: number;
};

type RuntimeEntry = {
  scope: AttachmentScope;
  /** Editable source; the editor opens this, never the (possibly compressed) upload file. */
  sourceFile: File;
  /** Current upload file: the source, or a compressed/prepared result. */
  file: File;
  /**
   * THUMBNAIL ONLY. The only object URL the store ever creates: a small blob
   * rendered in the sheet row. Empty ("", placeholder mark) until the serial
   * thumbnail producer finishes. NEVER an object URL for sourceFile/file.
   */
  objectUrl: string;
  /** Photo provenance: source originated as a JPEG photo (preserved across edits). */
  photoOrigin: boolean;
  /** Cached prepare result for the current source revision; cleared on edit/source change. */
  prepared: PreparedImage | null;
  checkpoint?: AttachmentCheckpoint;
  /** Current upload-attempt abort; distinct from the thumbnail abort. */
  abort: AbortController | null;
  /** Bumped on every claimed upload operation; stale callbacks compare against it. */
  generation: number;
  /** Thumbnail-only abort: cancels just the queued/running thumb producer. */
  thumbAbort: AbortController | null;
  /** Bumped per source revision for thumbnails, independent of upload generation. */
  thumbGeneration: number;
  /** Set when the row has been removed, so a racing job settles nowhere. */
  removed: boolean;
};

const runtime = new Map<string, RuntimeEntry>();
const runtimeKeys = new Map<string, Set<string>>();

function runtimeId(key: string, localId: string): string {
  return `${key} ${localId}`;
}

/** Read one row from its pane queue (a read selector over published state). */
function findItem(key: string, localId: string): AttachmentItem | null {
  return queueSnapshot(key)?.items.find((item) => item.localId === localId) ?? null;
}

export function adoptRuntime(key: string, localId: string, scope: AttachmentScope, file: File): void {
  runtime.set(runtimeId(key, localId), {
    scope,
    sourceFile: file,
    file,
    objectUrl: "", // thumbnail placeholder; no object URL is ever made for the source
    photoOrigin: isPhotoOrigin(metaFromFile(file)),
    prepared: null,
    abort: null,
    generation: 0,
    thumbAbort: null,
    thumbGeneration: 0,
    removed: false,
  });
  const ids = runtimeKeys.get(key) ?? new Set<string>();
  ids.add(localId);
  runtimeKeys.set(key, ids);
}

export function runtimeFile(key: string, localId: string): File | null {
  return runtime.get(runtimeId(key, localId))?.file ?? null;
}

/** The editable source file; the editor opens this, never the upload file. */
export function runtimeSourceFile(key: string, localId: string): File | null {
  return runtime.get(runtimeId(key, localId))?.sourceFile ?? null;
}

/** Trusted photo provenance for the current source revision. */
export function runtimePhotoOrigin(key: string, localId: string): boolean {
  return runtime.get(runtimeId(key, localId))?.photoOrigin ?? false;
}

/** Cached prepare result for the current source revision, or null if cleared. */
export function runtimePreparedImage(key: string, localId: string): PreparedImage | null {
  return runtime.get(runtimeId(key, localId))?.prepared ?? null;
}

export function runtimeObjectUrl(key: string, localId: string): string {
  return runtime.get(runtimeId(key, localId))?.objectUrl ?? "";
}

export function runtimeCheckpoint(key: string, localId: string): AttachmentCheckpoint | null {
  return runtime.get(runtimeId(key, localId))?.checkpoint ?? null;
}

export function runtimeAbort(key: string, localId: string): AbortController | null {
  return runtime.get(runtimeId(key, localId))?.abort ?? null;
}

export function runtimeGeneration(key: string, localId: string): number {
  return runtime.get(runtimeId(key, localId))?.generation ?? 0;
}

/** Claim a new operation synchronously; older attempts can no longer settle the row. */
export function bumpRuntimeGeneration(key: string, localId: string): number | null {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return null;
  entry.generation += 1;
  return entry.generation;
}

export function runtimeRemoved(key: string, localId: string): boolean {
  return runtime.get(runtimeId(key, localId))?.removed ?? true;
}

export function setRuntimeAbort(key: string, localId: string, abort: AbortController | null): AbortController | null {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return null;
  entry.abort = abort;
  return abort;
}

export function setRuntimeCheckpoint(key: string, localId: string, checkpoint: AttachmentCheckpoint): void {
  const entry = runtime.get(runtimeId(key, localId));
  if (entry) entry.checkpoint = checkpoint;
}

/** Drop a checkpoint once its remote upload is confirmed terminal or the handle is gone. */
export function clearRuntimeCheckpoint(key: string, localId: string): void {
  const entry = runtime.get(runtimeId(key, localId));
  if (entry) entry.checkpoint = undefined;
}

/**
 * Replace the source AND upload file (after an image edit). The prepared cache
 * is invalidated (new source revision) and photo origin is preserved. The
 * generation is monotonically bumped — never reset to 0 — so any stale
 * callback keyed on the prior generation can never match the new revision.
 * Checkpoint/abort reset: an edited row is a fresh queued source. The
 * thumbnail lifecycle (abort old, revoke old, regenerate) is driven by
 * beginThumbnail, never here: compression/mode changes reuse this file-swap
 * seam indirectly and must not touch a valid same-source thumbnail.
 */
export function replaceRuntimeFile(key: string, localId: string, file: File): void {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return;
  entry.sourceFile = file;
  entry.file = file;
  entry.prepared = null;
  entry.checkpoint = undefined;
  entry.abort = null;
  entry.generation += 1;
}

export function dropRuntime(key: string, localId: string): void {
  const rid = runtimeId(key, localId);
  const entry = runtime.get(rid);
  if (entry) {
    entry.removed = true;
    entry.abort?.abort();
    entry.thumbAbort?.abort(); // a queued/running thumbnail settles without alloc
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    // Drop the cached prepared File reference along with the URL/abort maps.
    entry.prepared = null;
  }
  runtime.delete(rid);
  runtimeKeys.get(key)?.delete(localId);
}

function newItem(meta: IncomingMeta, localId: string): AttachmentItem {
  const kind: AttachmentKind = isImageMeta(meta) ? "image" : "file";
  const base: AttachmentItem = {
    localId,
    kind,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    status: "queued",
    acknowledged: 0,
    errorText: "",
    recoverable: false,
    path: "",
    inserted: false,
    editNote: "",
    cancelIntent: false,
  };
  if (kind !== "image") return base;
  // Quality defaults by type: camera photos (JPEG, HEIC) start on smart
  // compression, everything else (PNG screenshots, diagrams) on the original.
  // originalBytes is the source size until a prepare result swaps in a
  // (smaller) upload file.
  const mode = defaultCompressionMode(meta);
  return { ...base, compressionMode: mode, imageIntent: "photo", originalBytes: meta.size };
}

const HEIC = /\.hei[cf]$/iu;

/** Photos compress by default; screenshots and other images keep their bytes. */
export function defaultCompressionMode(meta: IncomingMeta): "smart" | "original" {
  if (isPhotoOrigin(meta)) return "smart";
  if (meta.mime === "image/heic" || meta.mime === "image/heif" || HEIC.test(meta.name)) return "smart";
  return "original";
}

/** Add reviewed files to a pane queue and hold their browser objects. */
export function adoptIncoming(key: string, scope: AttachmentScope, files: readonly File[]): string[] {
  const added: string[] = [];
  write((record) => {
    const queue = record.queues[key] ?? { scopeKey: key, items: [], notice: "" };
    const items = [...queue.items];
    for (const file of files) {
      const localId = `att_${crypto.randomUUID()}`;
      adoptRuntime(key, localId, scope, file);
      items.push(newItem(metaFromFile(file), localId));
      added.push(localId);
    }
    record.queues[key] = { ...queue, items, notice: queue.notice };
  });
  // Rows are published first; thumbnails fill in asynchronously (placeholder
  // until then). The store never creates an object URL for the source File.
  for (const localId of added) beginThumbnail(key, localId);
  return added;
}

/**
 * Start (or replace) one row's small-thumbnail generation from its CURRENT
 * source File. The single choke point for adoption, edit, and restore:
 * abort any previous thumbnail revision, revoke its URL, reset to the empty
 * placeholder, bump the THUMBNAIL-only generation (upload generation is
 * untouched — a mode/preference change that keeps the same source never
 * calls this), and enqueue the serial producer. Non-image rows render no
 * <img> and never enter the shared image queue.
 */
function beginThumbnail(key: string, localId: string): void {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return;
  const item = findItem(key, localId);
  if (!item || item.kind !== "image") return;
  entry.thumbAbort?.abort();
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = "";
  }
  const thumbAbort = new AbortController();
  entry.thumbAbort = thumbAbort;
  entry.thumbGeneration += 1;
  const thumbGeneration = entry.thumbGeneration;
  const source = entry.sourceFile;
  // Capture the entry OBJECT: a reset/drop + re-adopt with the same id/source
  // /generation creates a NEW object and must never accept this late answer.
  const captured = entry;
  requestThumbnail({
    source,
    signal: thumbAbort.signal,
    isCurrent: () => {
      const current = runtime.get(runtimeId(key, localId));
      return current === captured
        && !captured.removed
        && captured.sourceFile === source
        && captured.thumbGeneration === thumbGeneration;
    },
    publish: (blob) => installThumbnail(captured, key, localId, source, thumbGeneration, blob),
  });
}

/**
 * Install a produced thumbnail after the await. Every identity axis is
 * re-validated here (the helper checks too): the entry exists, the source is
 * the exact File revision that requested it, the thumbnail generation is
 * current, and the thumbnail abort has not fired. A null/failed result keeps
 * (or returns to) the empty placeholder — the original source/upload File is
 * NEVER turned into an object URL. Only a real swap republishes the row so
 * React swaps the placeholder mark for the <img>.
 */
function installThumbnail(
  captured: RuntimeEntry,
  key: string,
  localId: string,
  source: File,
  thumbGeneration: number,
  blob: Blob | null,
): void {
  // Object identity first: a dropped/re-adopted id is a different entry even
  // if id, source File and generation number all line up.
  if (runtime.get(runtimeId(key, localId)) !== captured) return;
  if (captured.removed) return;
  if (captured.sourceFile !== source) return;        // an edit moved the source
  if (captured.thumbGeneration !== thumbGeneration) return; // a newer revision owns the row
  if (captured.thumbAbort?.signal.aborted) return;   // cancelled during production
  if (!blob) {
    if (captured.objectUrl) {
      URL.revokeObjectURL(captured.objectUrl);
      captured.objectUrl = "";
      patchItem(key, localId, {}); // publish the fallback to the placeholder
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const previous = captured.objectUrl;
  captured.objectUrl = url;
  if (previous) URL.revokeObjectURL(previous);
  patchItem(key, localId, {}); // the thumbnail-only change republished to React
}

export function setQueueNotice(key: string, notice: string): void {
  withQueue(key, (queue) => replaceItems(queue, queue.items, notice));
}

/** Ensure a queue exists so a pick-rejection reason can surface even when nothing adopts. */
export function ensureAttachmentQueue(key: string): void {
  write((record) => {
    if (!record.queues[key]) record.queues[key] = { scopeKey: key, items: [], notice: "" };
  });
}

export function patchItem(key: string, localId: string, patch: Partial<AttachmentItem>): void {
  withQueue(key, (queue) => {
    let changed = false;
    const items = queue.items.map((item) => {
      if (item.localId !== localId) return item;
      changed = true;
      return { ...item, ...patch };
    });
    if (changed) replaceItems(queue, items);
  });
}

export function patchStatus(
  key: string,
  localId: string,
  status: AttachmentStatus,
  extra?: Partial<AttachmentItem>,
): void {
  patchItem(key, localId, { status, ...extra });
}

export function setItemEditNote(key: string, localId: string, note: string): void {
  patchItem(key, localId, { editNote: note });
}

/**
 * Adopt an edited image: replace source AND upload file with the edited
 * result, invalidate the prepared cache (new source revision), and preserve
 * the photo origin. Upload identity resets to a fresh queued source. The
 * compression preference is preserved (smart/original stays the user's
 * choice); compression metadata resets to the new source until re-prepared.
 */
export function adoptEditedFile(
  key: string,
  localId: string,
  file: File,
  meta: { name: string; size: number; mime: string },
): void {
  replaceRuntimeFile(key, localId, file);
  patchItem(key, localId, {
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    kind: "image",
    status: "queued",
    acknowledged: 0,
    errorText: "",
    recoverable: false,
    path: "",
    inserted: false,
    editNote: "",
    cancelIntent: false,
    compressing: false,
    originalBytes: meta.size,
    compressionChanged: false,
    compressionReason: undefined,
  });
  // New source revision: abort + revoke the old thumbnail and regenerate from
  // the edited source. The old queued/late answer can no longer install.
  beginThumbnail(key, localId);
}

/**
 * Apply a cached prepare result: replace only the upload file + its identity
 * metadata. A legitimate fresh preparation has no checkpoint and no fired
 * abort, so a row that has either — a pending upload identity, or a cancelled
 * current owner — is refused: no caller can swap an in-flight upload's file
 * out from under it. The caller passes the source revision it prepared from
 * plus the generation it observed; if the source moved (edit), a newer claim
 * took the row, a checkpoint appeared, or the current abort fired, the result
 * is stale and is dropped. A non-aborted in-flight abort handle and the
 * generation itself are preserved (they belong to this attempt).
 */
export function setPreparedImage(
  key: string,
  localId: string,
  prepared: {
    sourceFile: File;
    file: File;
    reason: CompressionReason;
    originalBytes: number;
    changed: boolean;
    width?: number;
    height?: number;
  },
  generation: number,
): boolean {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return false;                                  // removed
  if (entry.sourceFile !== prepared.sourceFile) return false; // source moved (edit)
  if (entry.generation !== generation) return false;          // a newer claim owns the row
  if (entry.checkpoint) return false;                         // pending upload identity — never replace
  if (entry.abort?.signal.aborted) return false;              // cancelled during prepare
  entry.prepared = {
    file: prepared.file,
    reason: prepared.reason,
    originalBytes: prepared.originalBytes,
    changed: prepared.changed,
    width: prepared.width,
    height: prepared.height,
  };
  // Only the upload FILE swaps here. The preview is a thumbnail of the
  // unchanged SOURCE: compression/mode changes never regenerate or revoke it.
  entry.file = prepared.file;
  patchItem(key, localId, {
    name: prepared.file.name,
    size: prepared.file.size,
    mime: prepared.file.type ?? "",
    originalBytes: prepared.originalBytes,
    compressionReason: prepared.reason,
    compressionChanged: prepared.changed,
    compressing: false,
    outputWidth: prepared.width,
    outputHeight: prepared.height,
  });
  return true;
}

/** Safely idle: no active op, not committed, no cancel intent. */
function isSafelyIdle(item: AttachmentItem | null): item is AttachmentItem {
  if (!item) return false;
  if (item.status === "preparing" || item.status === "uploading" || item.status === "cancelling") return false;
  if (item.status === "committed") return false;
  if (item.scheduled) return false;
  return !item.cancelIntent;
}

/**
 * Set the per-image upload preference. Only on a safely idle row with no
 * unresolved remote handle: a preference change can never touch an uncertain
 * upload identity. Resets the upload file to the source + its meta; the smart
 * pipeline re-prepares (and re-applies the cached result) on the next idle.
 */
export function setPreference(key: string, localId: string, mode: "smart" | "original"): boolean {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return false;
  if (!isSafelyIdle(findItem(key, localId)) || entry.checkpoint) return false;
  entry.file = entry.sourceFile;
  patchItem(key, localId, {
    compressionMode: mode,
    name: entry.sourceFile.name,
    size: entry.sourceFile.size,
    mime: entry.sourceFile.type ?? "",
    originalBytes: entry.sourceFile.size,
    compressing: false,
    compressionChanged: false,
    compressionReason: undefined,
    outputWidth: undefined,
    outputHeight: undefined,
  });
  return true;
}

/**
 * Set the per-image rendering intent ('photo' compresses, 'detail' preserves
 * the source). Same guards as setPreference: only a safely idle row with no
 * unresolved remote handle. Resets the upload file to the source + its meta
 * and CLEARS the prepared cache (a cached photo result must never serve a
 * detail row); dimensions clear with the source switch.
 */
export function setImageIntent(key: string, localId: string, intent: AttachmentImageIntent): boolean {
  const entry = runtime.get(runtimeId(key, localId));
  if (!entry) return false;
  if (!isSafelyIdle(findItem(key, localId)) || entry.checkpoint) return false;
  entry.file = entry.sourceFile;
  entry.prepared = null;
  patchItem(key, localId, {
    imageIntent: intent,
    name: entry.sourceFile.name,
    size: entry.sourceFile.size,
    mime: entry.sourceFile.type ?? "",
    originalBytes: entry.sourceFile.size,
    compressing: false,
    compressionChanged: false,
    compressionReason: undefined,
    outputWidth: undefined,
    outputHeight: undefined,
  });
  return true;
}

export function markInserted(key: string, localId: string): void {
  patchItem(key, localId, { inserted: true });
}

export function clearInserted(key: string, localId: string): void {
  patchItem(key, localId, { inserted: false });
}

/** Tray order is path order on send: move one row to `index` (clamped). */
export function moveAttachment(key: string, localId: string, index: number): void {
  withQueue(key, (queue) => {
    const from = queue.items.findIndex((item) => item.localId === localId);
    if (from < 0) return;
    const items = [...queue.items];
    const [moved] = items.splice(from, 1);
    const to = Math.max(0, Math.min(items.length, Math.floor(index)));
    if (to === from) return;
    items.splice(to, 0, moved);
    replaceItems(queue, items);
  });
}

/** The reader chose to continue restored rows: they now behave like fresh picks. */
export function clearRestored(key: string, localId: string): void {
  patchItem(key, localId, { restored: false });
}

/**
 * Give a finished (committed or cancelled) row a new local id, in place, as a
 * fresh queued source. Its old id already has a journal tombstone, so a second
 * upload under that id could never be persisted for recovery. The runtime
 * entry moves with the row: the editable source, photo provenance, the
 * prepared cache and a finished thumbnail survive; any checkpoint must already
 * be gone. Returns the new id, or null when the row cannot be reissued.
 */
export function reissueAttachment(key: string, localId: string): string | null {
  const item = findItem(key, localId);
  const entry = runtime.get(runtimeId(key, localId));
  if (!item || !entry || entry.checkpoint) return null;
  if (item.status !== "committed" && item.status !== "cancelled") return null;
  const nextId = `att_${crypto.randomUUID()}`;
  const thumbPending = item.kind === "image" && !entry.objectUrl;
  entry.thumbAbort?.abort();
  entry.thumbAbort = null;
  entry.abort = null;
  entry.generation += 1;
  runtime.delete(runtimeId(key, localId));
  runtime.set(runtimeId(key, nextId), entry);
  const ids = runtimeKeys.get(key);
  ids?.delete(localId);
  ids?.add(nextId);
  withQueue(key, (queue) => {
    replaceItems(queue, queue.items.map((row) => row.localId !== localId ? row : {
      ...row,
      localId: nextId,
      status: "queued" as const,
      acknowledged: 0,
      errorText: "",
      recoverable: false,
      path: "",
      inserted: false,
      cancelIntent: false,
      restored: false,
      scheduled: false,
      transferPhase: undefined,
      stageTimings: undefined,
      transferTransport: undefined,
      speedBps: undefined,
      etaSeconds: undefined,
      waiting: false,
      compressing: false,
    }));
  });
  if (thumbPending) beginThumbnail(key, nextId);
  return nextId;
}

/**
 * Switch one image between smart compression and the original bytes. The
 * "text & detail" intent only ever kept the original, so choosing a quality
 * also settles the intent on photo (original mode already skips the codec).
 * Same guards as setPreference: the row must be safely idle with no remote
 * handle; a finished row is reissued first by the caller.
 */
export function setUploadQuality(key: string, localId: string, quality: "smart" | "original"): boolean {
  const item = findItem(key, localId);
  if (!item || item.kind !== "image") return false;
  if ((item.imageIntent ?? "photo") !== "photo" && !setImageIntent(key, localId, "photo")) return false;
  return setPreference(key, localId, quality);
}

export function removeAttachment(key: string, localId: string): void {
  withQueue(key, (queue) => {
    replaceItems(queue, queue.items.filter((item) => item.localId !== localId));
  });
  dropRuntime(key, localId);
}

/** Cancel/abort an in-flight transfer without removing the row. */
export function abortAttachment(key: string, localId: string): void {
  runtimeAbort(key, localId)?.abort();
}

/** Stop old-target follow-ups before retargeting the shared connection. */
export function pauseAttachmentTransfers(daemonId: string | null, herdSession: string | null): void {
  for (const row of runtime.values()) {
    if (row.scope.daemonId === daemonId && (row.scope.herdSession ?? null) === herdSession) row.abort?.abort();
  }
}

/**
 * Reconstruct one validated journal record into the live queue after a
 * reload. This ONLY restores store/runtime state: it never starts an upload,
 * never resumes, and makes no RPC. The caller (the current pane owner)
 * decides what to do with a checkpointed row.
 *
 * Fail-closed guards: the record is a codec-validated v1 record, but the key
 * tuple is rebuilt here and must match exactly; terminal records (committed /
 * cancelled — they should have been deleted on settle) are refused; a row or
 * runtime handle with the same local id already present is never overwritten.
 *
 * Restored shape: source/upload are the EXACT saved File objects, the
 * checkpoint is retained, upload generation starts at 0 (nothing is
 * scheduled: abort null, scheduled false), and the row is
 * checkpoint → error/recoverable (a status check or explicit user action
 * reconciles it) or queued without one. Live attempt state is cleared
 * (progress/speed/ETA/waiting/phase/compressing) while cancelIntent, mode and
 * imageIntent are preserved; provenance is derived from the SOURCE, never
 * from a compressed upload. The thumbnail is regenerated from the source —
 * no object URL for source/upload is ever created.
 */
export function restoreAttachmentRecord(record: AttachmentJournalRecord, scope: AttachmentScope = {
  daemonId: record.daemonId, paneId: record.paneId,
}): boolean {
  if (record.version !== 1) return false;
  if (record.daemonId !== attachmentStorageId(scope) || record.paneId !== scope.paneId) return false;
  const key = attachmentScopeKey(scope);
  const { localId } = record;
  if (record.item.localId !== localId) return false;
  // The frozen item describes the upload File exactly (codec already checked,
  // but restore fails closed rather than trusting the caller's assembly).
  if (
    record.item.name !== record.uploadFile.name
    || record.item.size !== record.uploadFile.size
    || record.item.mime !== (record.uploadFile.type ?? "")
  ) {
    return false;
  }
  // Terminal rows are journal garbage here: they are deleted at settle time.
  if (record.item.status === "committed" || record.item.status === "cancelled") return false;
  const rid = runtimeId(key, localId);
  if (runtime.has(rid)) return false; // a live runtime handle already owns this id
  if (queueSnapshot(key)?.items.some((item) => item.localId === localId)) return false; // row collision

  const hasCheckpoint = record.checkpoint !== undefined;
  const restored: AttachmentItem = {
    ...record.item,
    // No attempt is running: checkpointed uploads surface as recoverable
    // errors awaiting reconciliation; everything else waits queued.
    status: hasCheckpoint ? "error" : "queued",
    recoverable: hasCheckpoint,
    acknowledged: 0,
    scheduled: false,
    transferPhase: undefined,
    compressing: false,
    speedBps: undefined,
    etaSeconds: undefined,
    waiting: undefined,
    stageTimings: undefined,
    // cancelIntent is preserved exactly (cancelling + checkpoint → error with
    // cancelIntent true; it must never auto-resume).
    restored: true,
  };

  runtime.set(rid, {
    scope,
    sourceFile: record.sourceFile,
    file: record.uploadFile,
    objectUrl: "", // placeholder until the source thumbnail finishes
    photoOrigin: isPhotoOrigin(metaFromFile(record.sourceFile)),
    prepared: null,
    ...(hasCheckpoint ? { checkpoint: record.checkpoint } : {}),
    abort: null,
    generation: 0,
    thumbAbort: null,
    thumbGeneration: 0,
    removed: false,
  });
  const ids = runtimeKeys.get(key) ?? new Set<string>();
  ids.add(localId);
  runtimeKeys.set(key, ids);

  write((state) => {
    const queue = state.queues[key] ?? { scopeKey: key, items: [], notice: "" };
    state.queues[key] = { ...queue, items: [...queue.items, restored], notice: queue.notice };
  });
  // After publish: thumbnail from the editable source, never from an upload
  // blob URL. No RPC, no scheduling — the caller owns the next move.
  beginThumbnail(key, localId);
  return true;
}

export function queueSize(): number {
  return Object.keys(read().queues).length;
}
