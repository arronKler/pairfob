/**
 * Pure attachment model: limits review, queue views, draft insertion math and
 * committed-path validation. No DOM, no React, no stores: every rule here is
 * unit tested directly.
 */
import { utf8ByteLength } from "../../../lib/text-budget";
import { OPERATION_INPUT_LIMITS } from "../../../lib/operations";
import { ProtocolError } from "../../../lib/protocol/errors";
import { herdSessionScope } from "../../../lib/protocol/herd-sessions";

/** Upload limit numbers shared with the transfer module. */
export type AttachmentLimits = {
  readonly maxFileBytes: number;
  readonly maxBatchBytes: number;
  readonly maxFiles: number;
};

/**
 * Contract limits used for the capacity line and pick review until the
 * transfer module (the canonical source) has loaded once.
 */
export const FALLBACK_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxBatchBytes: 40 * 1024 * 1024,
  maxFiles: 5,
};

export type AttachmentKind = "image" | "file";

/**
 * Why a prepared image ended up the size it is. Structural mirror of the core
 * `prepareAttachmentImage` reason union (pwa/src/lib/attachment-image.ts); the
 * runtime never imports core here — this local type keeps the model decoupled
 * until integration wires the real pipeline.
 */
export type CompressionReason =
  | "compressed"
  | "small"
  | "preserved"
  | "unsupported"
  | "not-smaller"
  | "failed";

/** Per-image rendering intent; a new image defaults to 'photo'. */
export type AttachmentImageIntent = "photo" | "detail";

/** Live transfer phases a row can report; absent on idle rows. */
export type AttachmentTransferPhase = "waiting-p2p" | "persisting"
  | "queued"
  | "compressing"
  | "hashing"
  | "begin"
  | "sending"
  | "commit"
  | "status";

/** Stages surfaced through onStage: transfer phases after queue/compression. */
export type AttachmentTransferStage = Exclude<AttachmentTransferPhase, "queued" | "compressing" | "waiting-p2p" | "persisting">;

/** Pane ownership of an attachment queue. Root resolution stays server side. */
export type AttachmentScope = {
  daemonId: string | null;
  paneId: string;
  /** Omitted or null keeps the default session's queue and journal keys. */
  herdSession?: string | null;
};

/** Journal v1 keeps its tuple format; only named sessions namespace its daemon slot. */
export function attachmentStorageId(scope: AttachmentScope): string {
  return herdSessionScope(scope.daemonId ?? "", scope.herdSession ?? null);
}

export type AttachmentStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "cancelling"
  | "committed"
  | "error"
  | "cancelled";

export type AttachmentItem = {
  /** Stable client-side identity; the server upload_id arrives with the checkpoint. */
  localId: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  mime: string;
  status: AttachmentStatus;
  acknowledged: number;
  /** Server/localized failure text; empty when the item is not in error. */
  errorText: string;
  /** True when an explicit status check + resume may recover this item. */
  recoverable: boolean;
  /** Absolute workspace path, present once committed. */
  path: string;
  inserted: boolean;
  /** Non-empty when this image cannot be edited in the browser. */
  editNote: string;
  /**
   * The user asked to cancel. While true the row must never be resumed or
   * re-begun: only an explicit status check or another cancel may settle it.
   * The checkpoint is retained until the computer confirms a terminal state.
   */
  cancelIntent: boolean;
  /**
   * Measured upload rate in bytes/second. Present ONLY while an active upload
   * has produced a real post-baseline delta; it is finite and strictly
   * positive and is cleared for every paused/error/cancel/complete state.
   */
  speedBps?: number;
  /**
   * Estimated seconds remaining from the measured rate (raw fractional value).
   * Present only together with a finite positive rate and remaining bytes.
   */
  etaSeconds?: number;
  /**
   * A live upload has sent bytes but received no acknowledgement for the
   * confirmation-stall window. The transfer is not failed: the row shows a
   * waiting note instead of speed/ETA. Cleared on the next progress/terminal.
   */
  waiting?: boolean;
  /**
   * Per-image upload preference. 'smart' (the default for a new image) asks the
   * core pipeline to compress; 'original' uploads the exact source bytes.
   */
  compressionMode?: "smart" | "original";
  /** True while an image is being prepared (compressed) before upload begins. */
  compressing?: boolean;
  /** Original source bytes before any compression; present for image rows. */
  originalBytes?: number;
  /** Last prepare result reason from the core image pipeline (structural mirror). */
  compressionReason?: CompressionReason;
  /** True when the prepared upload file differs from the source. */
  compressionChanged?: boolean;
  /**
   * Per-image rendering intent. 'photo' (the default for a new image) lets the
   * core pipeline compress; 'detail' preserves the source exactly.
   */
  imageIntent?: AttachmentImageIntent;
  /** True while a transfer for this row is scheduled but not yet running. */
  scheduled?: boolean;
  /** Current transfer stage of the live attempt; absent on idle rows. */
  transferPhase?: AttachmentTransferPhase;
  /** Elapsed ms per completed stage of the current transfer attempt. */
  stageTimings?: Partial<Record<"persistence" | "compression" | "hashing" | "begin" | "sending" | "commit" | "status", number>>;
  /**
   * Live transport captured when the network attempt actually started
   * (relay vs direct). It is the path at that instant, NOT a claim that the
   * whole historical transfer used one route; the sheet labels it as such and
   * shows the current connection separately when they differ.
   */
  transferTransport?: "relay" | "p2p";
  /** Non-empty when the row may not survive a reload without re-picking. */
  persistenceWarning?: string;
  /** True when the row was restored from persistence rather than adopted live. */
  restored?: boolean;
  /** Pixel dimensions of the prepared upload image, when known. */
  outputWidth?: number;
  outputHeight?: number;
};

export type AttachmentQueue = {
  readonly scopeKey: string;
  readonly items: readonly AttachmentItem[];
  /** Transient line for rejections and results, rendered in an aria-live node. */
  readonly notice: string;
};

/** Checkpoint the transfer module needs to inspect or resume one upload. */
export type AttachmentCheckpoint = {
  uploadId: string;
  paneId: string;
  name: string;
  size: number;
  sha256: string;
  mime: string;
  /**
   * Wire protocol version. Missing means the legacy v1 upload; 2 is the
   * large-chunk variant. The UI only preserves this structurally — it never
   * picks, strips, or retries a version itself.
   */
  version?: 2;
};

/** Structural mirror of D2 UploadState, limited to fields the UI reads. */
export type UploadStateLike = {
  upload_id: string;
  state: "uploading" | "committed" | "cancelled";
  offset: number;
  size: number;
  sha256: string;
  chunk_bytes: number;
  path?: string;
  relative_path?: string;
  name?: string;
  mime?: string;
};

export type AttachmentTransferOptions = {
  signal?: AbortSignal;
  onProgress?: (acknowledged: number, total: number) => void;
  /** May await persistence before the transfer proceeds. */
  onCheckpoint?: (checkpoint: AttachmentCheckpoint) => void | Promise<void>;
  /** Fires as the transfer enters each live stage after queue/compression. */
  onStage?: (phase: AttachmentTransferStage) => void;
};

export type AnyLiveSession = object;

export type AttachmentTransferPort = {
  readonly limits: AttachmentLimits;
  upload(
    session: AnyLiveSession,
    paneId: string,
    file: File,
    options?: AttachmentTransferOptions,
  ): Promise<UploadStateLike>;
  resume(
    session: AnyLiveSession,
    checkpoint: AttachmentCheckpoint,
    file: File,
    options?: AttachmentTransferOptions,
  ): Promise<UploadStateLike>;
  inspect(session: AnyLiveSession, checkpoint: AttachmentCheckpoint): Promise<UploadStateLike>;
  cancel(session: AnyLiveSession, checkpoint: AttachmentCheckpoint): Promise<UploadStateLike>;
};

export type IncomingMeta = {
  name: string;
  size: number;
  mime: string;
};

export type RejectionCode = "fileTooLarge" | "batchTooLarge" | "tooManyFiles";

export type IncomingRejection = {
  name: string;
  code: RejectionCode;
};

export type ReviewResult = {
  accepted: readonly IncomingMeta[];
  rejected: readonly IncomingRejection[];
};

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|gif|ico|jfif|jpe?g|png|webp|heic|heif|svg)$/iu;

export function isImageMeta(meta: IncomingMeta): boolean {
  if (meta.mime.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.test(meta.name);
}

const JPEG_NAME = /\.jpe?g$/iu;
const SCREENSHOT_NAME = /screenshot|screen[\s_-]?shot|截屏/iu;

/**
 * Trusted photo provenance for compression: a source is a photo when it is a
 * JPEG (by MIME or extension) and its name does not look like a screenshot.
 * Preserved across edits so a PNG exported from a JPEG photo still compresses
 * as a photo; never inferred for PNG/other formats on fresh upload.
 */
export function isPhotoOrigin(meta: IncomingMeta): boolean {
  if (meta.mime !== "image/jpeg" && !JPEG_NAME.test(meta.name)) return false;
  return !SCREENSHOT_NAME.test(meta.name);
}

export function metaFromFile(file: File): IncomingMeta {
  return { name: file.name, size: file.size, mime: file.type ?? "" };
}

/**
 * Apply the 5 files / 20 MiB each / 40 MiB batch limits against the queue as it
 * stands. Rows the user can still reconcile (errors, cancelled) keep their slot
 * until explicitly removed, so the count is predictable instead of silently
 * changing while a status check is pending. Name+size is deliberately NOT a
 * duplicate signal: metadata cannot establish identity, and two distinct File
 * objects with the same name/size are both legitimate picks. Identity dedup
 * lives in the controller, keyed on File object references.
 */
export function reviewIncoming(
  incoming: readonly IncomingMeta[],
  existing: readonly AttachmentItem[],
  limits: AttachmentLimits,
): ReviewResult {
  const accepted: IncomingMeta[] = [];
  const rejected: IncomingRejection[] = [];
  // Source/original bytes reserve intake capacity: a compressed upload's
  // shrunken size must not let extra raw files in whose later Original switch
  // would exceed the batch. originalBytes is the source size for image rows;
  // non-images have none and fall back to their (only) size.
  const reservedBytes = (item: AttachmentItem): number => Math.max(item.originalBytes ?? item.size, item.size);
  let batchBytes = existing.reduce((total, item) => total + reservedBytes(item), 0);
  let fileCount = existing.length;
  for (const meta of incoming) {
    if (meta.size > limits.maxFileBytes) {
      rejected.push({ name: meta.name, code: "fileTooLarge" });
      continue;
    }
    if (batchBytes + meta.size > limits.maxBatchBytes) {
      rejected.push({ name: meta.name, code: "batchTooLarge" });
      continue;
    }
    if (fileCount >= limits.maxFiles) {
      rejected.push({ name: meta.name, code: "tooManyFiles" });
      continue;
    }
    accepted.push(meta);
    batchBytes += meta.size;
    fileCount += 1;
  }
  return { accepted, rejected };
}

export function queueBytes(items: readonly AttachmentItem[]): number {
  return items.reduce((total, item) => total + item.size, 0);
}

export type EditedImageRejection =
  | { code: "fileTooLarge"; limitKey: "maxFileBytes"; limit: number }
  | { code: "batchTooLarge"; limitKey: "maxBatchBytes"; limit: number };

/**
 * Which limit an edited image breaks, if any: the per-file cap first, then the
 * pane batch budget with every other row counted. The original file stays
 * whichever branch fires.
 */
export function editedImageRejection(
  editedBytes: number,
  otherBytes: number,
  limits: AttachmentLimits,
): EditedImageRejection | null {
  if (editedBytes > limits.maxFileBytes) {
    return { code: "fileTooLarge", limitKey: "maxFileBytes", limit: limits.maxFileBytes };
  }
  if (otherBytes + editedBytes > limits.maxBatchBytes) {
    return { code: "batchTooLarge", limitKey: "maxBatchBytes", limit: limits.maxBatchBytes };
  }
  return null;
}

export function progressPercent(item: AttachmentItem): number {
  if (item.size <= 0) return item.status === "committed" ? 100 : 0;
  return Math.max(0, Math.min(100, Math.floor((item.acknowledged / item.size) * 100)));
}

/** Measured-rate result: ETA exists only while finite bytes remain. */
export type AttachmentRate = {
  readonly speedBps: number;
  readonly etaSeconds?: number;
};

/**
 * Pure throughput/ETA math over a baseline delta and a monotonic elapsed time.
 * The baseline is the FIRST acknowledged sample of one attempt, so bytes that
 * already existed on the computer when a resume starts are never counted as
 * new throughput. Every non-finite/non-positive input yields null: callers
 * must never invent an initial, negative or NaN rate.
 */
export function measureUploadRate(
  deltaBytes: number,
  elapsedMs: number,
  remainingBytes: number,
): AttachmentRate | null {
  if (!Number.isFinite(deltaBytes) || !Number.isFinite(elapsedMs) || !Number.isFinite(remainingBytes)) return null;
  if (deltaBytes <= 0 || elapsedMs <= 0 || remainingBytes < 0) return null;
  const speedBps = deltaBytes / (elapsedMs / 1000);
  if (!Number.isFinite(speedBps) || speedBps <= 0) return null;
  if (remainingBytes === 0) return { speedBps };
  const etaSeconds = remainingBytes / speedBps;
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) return { speedBps };
  return { speedBps, etaSeconds };
}

/** Rounded speed in KiB/s below 1 MiB/s, MiB/s at/above it. Null on garbage. */
export type SpeedParts = { readonly value: number; readonly unit: "kib" | "mib" };

export function speedParts(bytesPerSecond: number): SpeedParts | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  const round1 = (value: number): number => (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10);
  const kib = bytesPerSecond / 1024;
  if (kib < 1024) return { value: round1(kib), unit: "kib" };
  return { value: round1(kib / 1024), unit: "mib" };
}

/** Approximate ETA for display: whole seconds under a minute, minutes beyond. */
export type EtaParts = { readonly kind: "seconds" | "minutes"; readonly value: number };

export function etaParts(seconds: number): EtaParts | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return { kind: "seconds", value: Math.ceil(seconds) };
  return { kind: "minutes", value: Math.max(1, Math.round(seconds / 60)) };
}

export function isActive(item: AttachmentItem): boolean {
  return item.status === "preparing" || item.status === "uploading";
}

export function canInsert(item: AttachmentItem): boolean {
  return item.status === "committed" && Boolean(item.path) && !item.inserted;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

/**
 * Insert absolute paths at a selection in a draft without ever sending it. A
 * single space separates tokens from adjacent non-whitespace text on either
 * side, so a caret sitting inside a word never produces `/pathsuffix`. Text on
 * both sides and the selection position are preserved.
 */
export type InsertionResult = { text: string; caret: number };

export function insertPathsAt(
  before: string,
  after: string,
  paths: readonly string[],
): InsertionResult {
  let text = before;
  for (const path of paths) {
    if (text && !/\s$/u.test(text)) text += " ";
    text += path;
  }
  const caret = text.length;
  if (after) {
    if (!/\s$/u.test(text) && !/^\s/u.test(after)) text += " ";
    text += after;
  }
  return { text, caret };
}

/** The exact final assembled draft must fit; the insertion never truncates. */
export function insertionTextFits(text: string): boolean {
  return utf8ByteLength(text) <= OPERATION_INPUT_LIMITS.prompt;
}

const ABSOLUTE_PATH = /^\/(?:[^\u0000-\u001f\u007f/]+\/)*[^\u0000-\u001f\u007f]+$/u;

/**
 * A committed path must be an absolute, control-character-free POSIX path. The
 * server is authoritative; this is a final UI guard so a malformed response can
 * never be inserted as keys or split into several lines.
 */
export function safeCommittedPath(path: unknown): path is string {
  return typeof path === "string" && ABSOLUTE_PATH.test(path) && !path.includes("\\");
}

/** Validate a terminal UploadState against the item before adopting it. */
export function committedUpload(item: AttachmentItem, state: UploadStateLike): AttachmentItem | null {
  if (state.state !== "committed") return null;
  if (!safeCommittedPath(state.path)) return null;
  if (state.size !== item.size || state.upload_id === "") return null;
  if (state.offset !== item.size || !/^[0-9a-f]{64}$/u.test(state.sha256)) return null;
  return {
    ...item,
    status: "committed",
    acknowledged: state.size,
    path: state.path,
    errorText: "",
    recoverable: false,
    cancelIntent: false,
  };
}

/** An uploading/terminal state still needs reconciliation; fold in its offset. */
export function foldUploadingState(
  item: AttachmentItem,
  state: UploadStateLike,
  badResponseText?: () => string,
): AttachmentItem {
  if (state.state === "cancelled") {
    return { ...item, status: "cancelled", recoverable: false, errorText: "", cancelIntent: false };
  }
  if (state.state === "uploading") {
    const acknowledged = Math.max(item.acknowledged, Math.min(state.offset, item.size));
    return { ...item, status: "uploading", acknowledged };
  }
  return committedUpload(item, state) ?? {
    ...item,
    status: "error",
    recoverable: true,
    // Localized at the attach-copy boundary; the protocol shape is untouched.
    errorText: badResponseText ? badResponseText() : "bad response",
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

/**
 * Map a transfer failure to an item patch. `unknown_outcome` and expired
 * handles stay recoverable: only an explicit user action reconciles them.
 */
export function uploadErrorPatch(
  item: AttachmentItem,
  error: unknown,
  messageOf: (error: unknown) => string,
): Pick<AttachmentItem, "status" | "errorText" | "recoverable" | "cancelIntent"> {
  if (isAbortError(error)) return { status: item.status, errorText: item.errorText, recoverable: false, cancelIntent: item.cancelIntent };
  const code = error instanceof ProtocolError ? error.code : "";
  if (code === "workspace_not_found") {
    return { status: "error", errorText: "workspace_not_found", recoverable: false, cancelIntent: false };
  }
  const recoverable = code === "unknown_outcome" || code === "timeout"
    || code === "disconnected" || code === "reconnecting" || code === "backpressure";
  return { status: "error", errorText: messageOf(error) || code || "upload failed", recoverable, cancelIntent: item.cancelIntent };
}
