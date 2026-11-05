/**
 * Fresh-upload image preparation duty.
 *
 * Wraps the core `prepareAttachmentImage` (pwa/src/lib/attachment-image.ts)
 * behind an injectable preparer so tests never need the real codec worker.
 * Preparation is DEFERRED until a fresh upload job starts — never on pick or
 * resume. Original mode returns the exact source without calling the preparer;
 * smart mode prepares the source revision once and caches the result so the
 * same revision is never repeatedly decoded. Resume always reuses the
 * checkpoint's exact upload file and bypasses compression entirely.
 *
 * This module never touches the frozen snapshot directly: it reads runtime
 * accessors and writes through store setters (patchItem / setPreparedImage),
 * so a prepared result lands atomically with its identity metadata and the
 * editable source is preserved for future edits (no lossy re-encode chain).
 *
 * Guards run after EVERY await (the lazy core import and the prepare call
 * itself): a cancel, an edit, a remove, a stale scope/session, or a newer
 * generation claim must never install a result or start a Begin. Only the
 * current owner — same generation, same source, no checkpoint, no fired abort,
 * live scope/session — may install. setPreparedImage re-checks all of this.
 *
 * Return contract: a File means "upload this"; null means "do NOT Begin" —
 * the caller settles this attempt only and preserves any checkpoint for
 * reconciliation. null is never a "fall back to source" signal. The ONLY
 * graceful original fallback is an explicit "failed" result installed here
 * after every ownership/source guard, so the upload proceeds with the exact
 * source under correct, atomic metadata.
 */
import type { AttachmentItem } from "./attach-model";
import {
  attachmentScopeKey,
  patchItem,
  queueSnapshot,
  runtimeCheckpoint,
  runtimeFile,
  runtimeGeneration,
  runtimePhotoOrigin,
  runtimePreparedImage,
  runtimeRemoved,
  runtimeSourceFile,
  setPreparedImage,
  type AttachmentScope,
  type PreparedImage,
} from "./attachments-store";
// Type-only import of the real core result/options (the module loads lazily at
// runtime via resolvePreparer); no core stub is duplicated here.
import type { AttachmentImageOptions, AttachmentImageResult } from "../../../lib/attachment-image";

export type { AttachmentImageOptions, AttachmentImageResult };
export type ImagePreparer = (file: File, options?: AttachmentImageOptions) => Promise<AttachmentImageResult>;

let injectedPreparer: ImagePreparer | null = null;

/**
 * Tests inject a fake preparer; production leaves this null and the real core
 * loads lazily. Returns the preparer so a test can restore null in teardown.
 */
export function setImagePreparer(preparer: ImagePreparer | null): ImagePreparer | null {
  injectedPreparer = preparer;
  return preparer;
}

async function resolvePreparer(): Promise<ImagePreparer> {
  if (injectedPreparer) return injectedPreparer;
  // Lazy import: the core codec worker loads ONLY when a smart image actually
  // prepares. A missing/broken core never blocks non-image / original / resume
  // paths; a non-abort import failure degrades to an original "failed" result.
  const mod = await import("../../../lib/attachment-image");
  return mod.prepareAttachmentImage;
}

function readItem(key: string, localId: string): AttachmentItem | null {
  return queueSnapshot(key)?.items.find((candidate) => candidate.localId === localId) ?? null;
}

/** True when this generation still owns the row, is not cancelled, has no
 *  pending upload identity, and the owner scope/session is still live. */
function owns(
  key: string,
  localId: string,
  generation: number,
  signal: AbortSignal,
  stillOwner: () => boolean,
): boolean {
  if (runtimeRemoved(key, localId)) return false;
  if (runtimeGeneration(key, localId) !== generation) return false;
  if (signal.aborted) return false;
  if (runtimeCheckpoint(key, localId)) return false; // a Begin already owns the row
  return stillOwner();
}

/** Same generation and not removed — used to settle only this attempt's flags. */
function isCurrent(key: string, localId: string, generation: number): boolean {
  return !runtimeRemoved(key, localId) && runtimeGeneration(key, localId) === generation;
}

/** Install a prepared result through the full guard + setPreparedImage, returning
 *  the runtime upload File (now the prepared result) or null if refused. */
function installPrepared(
  key: string,
  localId: string,
  generation: number,
  signal: AbortSignal,
  stillOwner: () => boolean,
  sourceFile: File,
  result: PreparedImage,
): File | null {
  if (!owns(key, localId, generation, signal, stillOwner)) return null;
  const ok = setPreparedImage(
    key,
    localId,
    {
      sourceFile,
      file: result.file,
      reason: result.reason,
      originalBytes: result.originalBytes,
      changed: result.changed,
      width: result.width,
      height: result.height,
    },
    generation,
  );
  return ok ? runtimeFile(key, localId) : null;
}

/**
 * Prepare a fresh-upload image for upload. Returns the File to upload, or null
 * when the row is no longer the current owner (do NOT Begin — settle only).
 *
 * Non-image, original-mode and Text/Detail rows return the exact source
 * synchronously without calling the preparer; an UNSET mode defaults to
 * smart and an unset intent to photo. A cached
 * result for the current source revision is re-installed through the same
 * owns/source/checkpoint/abort guards + setPreparedImage (a setPreference
 * reset may have swapped runtimeFile back to the source, so the cache must be
 * re-applied, not just read, or committed validation / resume bytes break).
 * The smart-photo preparer receives the abort signal (cancel during prepare
 * aborts the core worker) and the trusted photo origin ('detail' rows never
 * reach the codec).
 * A non-abort preparer failure with
 * ownership intact degrades to an explicit original "failed" result.
 */
export async function prepareFreshImage(
  scope: AttachmentScope,
  localId: string,
  generation: number,
  signal: AbortSignal,
  stillOwner: () => boolean,
): Promise<File | null> {
  const key = attachmentScopeKey(scope);
  const item = readItem(key, localId);
  if (!item) return null;
  const sourceFile = runtimeSourceFile(key, localId);
  if (!sourceFile) return null;
  // Non-image, original-mode and TEXT/Detail rows upload the exact source
  // without the codec. An unset mode defaults to smart; an unset intent
  // defaults to photo (detail preserves the source byte-for-byte).
  const smart = (item.compressionMode ?? "smart") === "smart"
    && (item.imageIntent ?? "photo") === "photo";
  if (!(item.kind === "image" && smart)) return sourceFile;
  // Cached result for the current source revision (cleared on edit). Re-install
  // it through the owns guard + setPreparedImage so runtimeFile + item metadata
  // match the actual upload File; never just return the cached File directly.
  const cached = runtimePreparedImage(key, localId);
  if (cached) return installPrepared(key, localId, generation, signal, stillOwner, sourceFile, cached);
  const photo = runtimePhotoOrigin(key, localId);
  const intent = item.imageIntent ?? "photo";
  patchItem(key, localId, { compressing: true });
  let result: AttachmentImageResult | null = null;
  try {
    const preparer = await resolvePreparer();
    if (!owns(key, localId, generation, signal, stillOwner)) return null; // after lazy import
    result = await preparer(sourceFile, { signal, photo, intent });
  } catch {
    // Abort (cancel) → never Begin; the cancel flow settles. An unexpected
    // non-abort failure (core import/codec fault) with ownership intact
    // degrades gracefully: install the exact source as a "failed" result so the
    // upload proceeds with correct atomic metadata. Stale (lost ownership) → null.
    if (signal.aborted || !owns(key, localId, generation, signal, stillOwner)) return null;
    result = { file: sourceFile, changed: false, originalBytes: sourceFile.size, reason: "failed" };
  } finally {
    // Clear this attempt's compressing flag only if it still owns the row — a
    // newer claim owns its own flag state.
    if (isCurrent(key, localId, generation)) patchItem(key, localId, { compressing: false });
  }
  if (!result) return null;
  return installPrepared(
    key,
    localId,
    generation,
    signal,
    stillOwner,
    sourceFile,
    { ...result, width: result.width, height: result.height },
  );
}
