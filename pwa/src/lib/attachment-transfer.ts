// Cooperative attachment upload transport. Wire contract: proto/workspace-upload.md.
// Pure transfer logic: no drafts, no PTY keys, no prompts, no UI. Mutations
// are attempted once (session methods already generate fresh operation_id
// inside trackMutationDelivery); failures surface as-is and are never
// replayed automatically.
import { ProtocolError } from "./protocol/errors.ts";
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_CHUNK_BYTES_V2,
  validAttachmentDigest,
  validUploadID,
  type UploadState,
} from "./protocol/attachments.ts";
import type { LiveSession } from "./protocol/session-types.ts";
import { pumpWindowedUpload, UPLOAD_WINDOW_MAX_IN_FLIGHT, type WindowWrite } from "./attachment-window.ts";
// SHA-256 and canonical base64 run on the supplied off-thread codec; the
// transfer layer owns neither the hash nor the slice encode anymore.
import { encodeAttachmentChunk, hashAttachmentOffThread } from "./attachment-codec.ts";
import { newUUID } from "./ids";

export const ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_BATCH_BYTES = 40 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 5;
export const ATTACHMENT_CHUNK_BYTES = ATTACHMENT_UPLOAD_CHUNK_BYTES;

export type AttachmentCheckpoint = {
  uploadId: string;
  paneId: string;
  name: string;
  size: number;
  sha256: string;
  mime: string;
  /**
   * Wire routing chosen before the initial Begin. 2 is the 131072-byte V2
   * windowed upload; absence means the legacy 32768-byte sequential upload.
   * The value never changes for the life of one upload_id.
   */
  version?: 2;
};

export type AttachmentTransferStage = "hashing" | "begin" | "sending" | "commit" | "status";

export type AttachmentTransferOptions = {
  signal?: AbortSignal;
  onProgress?: (acknowledged: number, total: number) => void;
  onCheckpoint?: (checkpoint: AttachmentCheckpoint) => void | Promise<void>;
  /**
   * Diagnostics only: fired synchronously as the transfer enters each live
   * stage. The returned promise is NEVER awaited (it cannot gate or delay
   * the wire) and a throw/rejection here can never fail the transfer
   * (see emitStage).
   */
  onStage?: (stage: AttachmentTransferStage) => void | Promise<void>;
};

/**
 * Announce a transfer stage without awaiting it. Stage callbacks are pure
 * diagnostics: the observer is invoked synchronously, but its returned
 * promise (if any) is only tail-handled to swallow rejections. A synchronous
 * throw is caught here. Callers re-check abort after this returns, because a
 * synchronous observer may cancel the transfer before the next RPC.
 */
function emitStage(
  options: AttachmentTransferOptions | undefined,
  stage: AttachmentTransferStage,
): void {
  let result: unknown;
  try {
    result = options?.onStage?.(stage);
  } catch {
    /* a synchronous observer throw must never fail the transfer */
    return;
  }
  // Attach the rejection handler without awaiting: diagnostics must never
  // block or reject the wire, and the synchronous attachment prevents an
  // unhandled-rejection crash for an already-rejected observer promise.
  Promise.resolve(result).catch(() => {
    /* diagnostic observer rejection swallowed */
  });
}

type UploadMethods = {
  workspaceUploadBegin: NonNullable<LiveSession["workspaceUploadBegin"]>;
  workspaceUploadWrite: NonNullable<LiveSession["workspaceUploadWrite"]>;
  workspaceUploadStatus: NonNullable<LiveSession["workspaceUploadStatus"]>;
  workspaceUploadCommit: NonNullable<LiveSession["workspaceUploadCommit"]>;
  workspaceUploadCancel: NonNullable<LiveSession["workspaceUploadCancel"]>;
};

function abortError(): DOMException {
  return new DOMException("附件传输已取消", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function requireUploadMethods(session: LiveSession): UploadMethods {
  if (
    !session.workspaceUploadBegin
    || !session.workspaceUploadWrite
    || !session.workspaceUploadStatus
    || !session.workspaceUploadCommit
    || !session.workspaceUploadCancel
  ) {
    throw new ProtocolError("forbidden", "电脑端版本不支持附件，请确认电脑在线并更新到最新版本");
  }
  return session as UploadMethods;
}

/**
 * Bind the five V2 RPCs onto the legacy field names. Returns null unless V2 is
 * explicitly advertised AND all five methods are present, so the caller can
 * fall back to the legacy selection BEFORE any RPC is sent.
 */
function bindV2UploadMethods(session: LiveSession): UploadMethods | null {
  if (session.supportsUploadV2?.() !== true) return null;
  const {
    workspaceUploadBeginV2: begin,
    workspaceUploadWriteV2: write,
    workspaceUploadStatusV2: status,
    workspaceUploadCommitV2: commit,
    workspaceUploadCancelV2: cancel,
  } = session;
  if (
    typeof begin !== "function"
    || typeof write !== "function"
    || typeof status !== "function"
    || typeof commit !== "function"
    || typeof cancel !== "function"
  ) {
    return null;
  }
  return {
    workspaceUploadBegin: begin.bind(session),
    workspaceUploadWrite: write.bind(session),
    workspaceUploadStatus: status.bind(session),
    workspaceUploadCommit: commit.bind(session),
    workspaceUploadCancel: cancel.bind(session),
  };
}

/** Wire version for a brand-new upload; chosen once, before the initial Begin. */
function chooseUploadMethods(session: LiveSession): { methods: UploadMethods; version: 2 | 1 } {
  const v2 = bindV2UploadMethods(session);
  if (v2) return { methods: v2, version: 2 };
  return { methods: requireUploadMethods(session), version: 1 };
}

/**
 * Resolve methods for a retained checkpoint. A version-2 checkpoint stays on
 * V2 for its whole life: if the capability was lost (reconnect to an older
 * daemon), the checkpoint is preserved and this throws without touching a
 * legacy RPC. There is never a new Begin on resume/inspect/cancel.
 */
function requireCheckpointMethods(session: LiveSession, checkpoint: AttachmentCheckpoint): UploadMethods {
  if (checkpoint.version === 2) {
    const v2 = bindV2UploadMethods(session);
    if (!v2) throw new ProtocolError("forbidden", "电脑端当前不支持 V2 附件上传，无法继续该上传；检查点已保留");
    return v2;
  }
  return requireUploadMethods(session);
}

function requireNonEmptyText(value: string, label: string, max: number): void {
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProtocolError("invalid_argument", `${label} 非法`);
  }
}

export function validateAttachmentCheckpoint(checkpoint: AttachmentCheckpoint): void {
  if (!validUploadID(checkpoint.uploadId)) throw new ProtocolError("invalid_argument", "upload_id 非法");
  requireNonEmptyText(checkpoint.paneId, "pane_id", 256);
  requireNonEmptyText(checkpoint.name, "name", 256);
  requireNonEmptyText(checkpoint.mime, "mime", 128);
  if (!validAttachmentDigest(checkpoint.sha256)) throw new ProtocolError("invalid_argument", "sha256 非法");
  // Only absent (legacy) or exactly 2 are routable; any other explicit value
  // is a corrupt/foreign checkpoint and must never reach an RPC.
  if (checkpoint.version !== undefined && checkpoint.version !== 2) {
    throw new ProtocolError("invalid_argument", "检查点版本非法");
  }
  if (!Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0) {
    throw new ProtocolError("invalid_argument", "附件大小非法");
  }
  if (checkpoint.size > ATTACHMENT_MAX_FILE_BYTES) throw new ProtocolError("too_large", "附件大小超出限制");
}

function validateFile(file: File): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new ProtocolError("invalid_argument", "文件大小非法");
  if (file.size > ATTACHMENT_MAX_FILE_BYTES) throw new ProtocolError("too_large", "单个附件不能超过 20 MiB");
}

/**
 * Public hashing entry point: delegates verbatim to the off-thread codec
 * (one short-lived worker per call, one bounded cooperative fallback if the
 * worker cannot run). Same lowercase-hex return and abort semantics as the
 * former cooperative implementation.
 */
export async function hashAttachmentFile(file: File, signal?: AbortSignal): Promise<string> {
  return hashAttachmentOffThread(file, signal);
}

function stateMatchesCheckpoint(state: UploadState, checkpoint: AttachmentCheckpoint, operation: string): void {
  if (state.upload_id !== checkpoint.uploadId) throw new ProtocolError("conflict", `${operation} 响应 upload_id 不匹配`);
  if (state.size !== checkpoint.size) throw new ProtocolError("conflict", `${operation} 响应 size 与检查点不一致`);
  if (state.sha256 !== checkpoint.sha256) throw new ProtocolError("conflict", `${operation} 响应 sha256 与检查点不一致`);
  const expectedChunkBytes = checkpoint.version === 2 ? ATTACHMENT_UPLOAD_CHUNK_BYTES_V2 : ATTACHMENT_CHUNK_BYTES;
  if (state.chunk_bytes !== expectedChunkBytes) throw new ProtocolError("conflict", `${operation} 响应 chunk_bytes 非法`);
  // Committed identity: the display name and normalized MIME must match what
  // Begin was given; the on-disk basename lives in path/relative_path only.
  if (state.state === "committed") {
    if (state.name !== checkpoint.name) throw new ProtocolError("conflict", `${operation} 响应 name 与检查点不一致`);
    if (state.mime !== checkpoint.mime) throw new ProtocolError("conflict", `${operation} 响应 mime 与检查点不一致`);
  }
}

/** Hash the file locally and verify its identity against a server checkpoint. */
async function verifyFileIdentity(
  file: File,
  checkpoint: AttachmentCheckpoint,
  state: UploadState,
  operation: string,
  signal?: AbortSignal,
): Promise<void> {
  if (file.size !== checkpoint.size) throw new ProtocolError("conflict", `${operation} 本地文件大小与检查点不一致`);
  const digest = await hashAttachmentFile(file, signal);
  if (digest !== checkpoint.sha256) throw new ProtocolError("conflict", `${operation} 本地文件内容与检查点 sha256 不一致`);
  stateMatchesCheckpoint(state, checkpoint, operation);
}

/**
 * V2 transfer: 131072-byte chunks through the bounded in-flight window. Each
 * send reads exactly its own slice (the whole file is never buffered), aborts
 * before the read and before the RPC, and proves the receipt is still the
 * immutable checkpoint record with a durable end offset equal to this write.
 * Every send promise is observed by the window scheduler.
 */
async function writeChunksV2(
  methods: UploadMethods,
  checkpoint: AttachmentCheckpoint,
  file: File,
  fromOffset: number,
  options?: AttachmentTransferOptions,
): Promise<number> {
  const send = async (write: WindowWrite): Promise<number> => {
    checkAbort(options?.signal);
    const dataB64 = await encodeAttachmentChunk(file, write.offset, write.end, options?.signal);
    checkAbort(options?.signal);
    const state = await methods.workspaceUploadWrite({
      pane_id: checkpoint.paneId,
      upload_id: checkpoint.uploadId,
      offset: write.offset,
      data_b64: dataB64,
    });
    if (state.state !== "uploading") {
      throw new ProtocolError("conflict", "上传状态在写入期间被终结；请刷新确认");
    }
    stateMatchesCheckpoint(state, checkpoint, "WorkspaceUploadWrite");
    if (state.offset !== write.end) {
      // Same uncertain-outcome rule as legacy: reconcile via status/resume,
      // never by re-sending this or a later window.
      throw new ProtocolError("conflict", `WorkspaceUploadWrite 确认偏移量 ${state.offset} 与请求 ${write.end} 不一致`);
    }
    return write.end;
  };
  return pumpWindowedUpload(file.size, fromOffset, ATTACHMENT_UPLOAD_CHUNK_BYTES_V2, UPLOAD_WINDOW_MAX_IN_FLIGHT, {
    signal: options?.signal,
    send,
    onProgress: (acknowledged) => options?.onProgress?.(acknowledged, file.size),
  });
}

async function writeChunks(
  methods: UploadMethods,
  checkpoint: AttachmentCheckpoint,
  file: File,
  fromOffset: number,
  options?: AttachmentTransferOptions,
): Promise<number> {
  if (checkpoint.version === 2) return writeChunksV2(methods, checkpoint, file, fromOffset, options);
  let acknowledged = fromOffset;
  options?.onProgress?.(acknowledged, file.size);
  while (acknowledged < file.size) {
    checkAbort(options?.signal);
    const end = Math.min(acknowledged + ATTACHMENT_CHUNK_BYTES, file.size);
    const dataB64 = await encodeAttachmentChunk(file, acknowledged, end, options?.signal);
    checkAbort(options?.signal);
    const state = await methods.workspaceUploadWrite({
      pane_id: checkpoint.paneId,
      upload_id: checkpoint.uploadId,
      offset: acknowledged,
      data_b64: dataB64,
    });
    if (state.state !== "uploading") {
      throw new ProtocolError("conflict", "上传状态在写入期间被终结；请刷新确认");
    }
    stateMatchesCheckpoint(state, checkpoint, "WorkspaceUploadWrite");
    if (state.offset !== end) {
      // Uncertain prior write outcomes must be reconciled by an explicit
      // status read/resume — never by silently re-sending bytes here.
      throw new ProtocolError("conflict", `WorkspaceUploadWrite 确认偏移量 ${state.offset} 与请求 ${end} 不一致`);
    }
    acknowledged = state.offset;
    options?.onProgress?.(acknowledged, file.size);
    await yieldToEventLoop();
  }
  return acknowledged;
}

async function commitUpload(
  methods: UploadMethods,
  checkpoint: AttachmentCheckpoint,
): Promise<UploadState> {
  const committed = await methods.workspaceUploadCommit(checkpoint.paneId, checkpoint.uploadId);
  if (committed.state !== "committed") throw new ProtocolError("conflict", "WorkspaceUploadCommit 未返回 committed 状态");
  stateMatchesCheckpoint(committed, checkpoint, "WorkspaceUploadCommit");
  if (committed.offset !== committed.size) throw new ProtocolError("conflict", "提交时偏移量与文件大小不一致");
  return committed;
}

/**
 * Hash, begin, transfer and commit one attachment. The checkpoint is emitted
 * before the first RPC so callers can retain the upload id immediately.
 */
export async function uploadAttachment(
  session: LiveSession,
  paneId: string,
  file: File,
  options?: AttachmentTransferOptions,
): Promise<UploadState> {
  // Version is selected once, BEFORE any RPC. There is no fallback after this
  // point: a V2 error (including unknown_op) surfaces as-is and is reconciled
  // only by an explicit resume on the retained version-2 checkpoint.
  const { methods, version } = chooseUploadMethods(session);
  validateFile(file);
  requireNonEmptyText(file.name, "name", 256);
  const mime = file.type || "application/octet-stream";
  requireNonEmptyText(mime, "mime", 128);
  checkAbort(options?.signal);

  emitStage(options, "hashing");
  checkAbort(options?.signal); // a sync observer may abort before hashing
  const digest = await hashAttachmentFile(file, options?.signal);
  const checkpoint: AttachmentCheckpoint = {
    uploadId: newUUID(),
    paneId,
    name: file.name,
    size: file.size,
    sha256: digest,
    mime,
  };
  if (version === 2) checkpoint.version = 2;
  // Persistence may be awaited (e.g. durable journal write) before any RPC is
  // sent; Begin waits for it, and an abort during the wait blocks Begin.
  await options?.onCheckpoint?.(checkpoint);
  checkAbort(options?.signal);

  emitStage(options, "begin");
  checkAbort(options?.signal); // a sync observer may abort before the RPC
  const begun = await methods.workspaceUploadBegin({
    pane_id: paneId,
    upload_id: checkpoint.uploadId,
    name: file.name,
    size: file.size,
    sha256: digest,
    mime,
  });
  if (begun.state !== "uploading") throw new ProtocolError("conflict", "WorkspaceUploadBegin 未返回 uploading 状态");
  if (begun.offset !== 0) throw new ProtocolError("conflict", "WorkspaceUploadBegin 偏移量必须为 0");
  stateMatchesCheckpoint(begun, checkpoint, "WorkspaceUploadBegin");

  // 'sending' means real chunk writes; an empty file commits with no sends.
  if (file.size > 0) {
    emitStage(options, "sending");
    checkAbort(options?.signal);
  }
  await writeChunks(methods, checkpoint, file, 0, options);
  checkAbort(options?.signal);
  emitStage(options, "commit");
  checkAbort(options?.signal); // a sync observer may abort before Commit
  return commitUpload(methods, checkpoint);
}

/**
 * Explicit user-invoked resume. Reads status FIRST, verifies file identity,
 * then continues from the server-acknowledged offset. Never replays Begin.
 */
export async function resumeAttachment(
  session: LiveSession,
  checkpoint: AttachmentCheckpoint,
  file: File,
  options?: AttachmentTransferOptions,
): Promise<UploadState> {
  validateAttachmentCheckpoint(checkpoint);
  const methods = requireCheckpointMethods(session, checkpoint);
  validateFile(file);
  checkAbort(options?.signal);

  // Resume ALWAYS reconciles server state first; there is never a Begin here.
  emitStage(options, "status");
  checkAbort(options?.signal); // a sync observer may abort before the RPC
  const status = await methods.workspaceUploadStatus(checkpoint.paneId, checkpoint.uploadId);
  if (status.upload_id !== checkpoint.uploadId) throw new ProtocolError("conflict", "WorkspaceUploadStatus 响应 upload_id 不匹配");

  if (status.state === "committed") {
    emitStage(options, "hashing");
    checkAbort(options?.signal);
    await verifyFileIdentity(file, checkpoint, status, "resumeAttachment", options?.signal);
    options?.onProgress?.(status.size, status.size);
    return status;
  }
  if (status.state === "cancelled") throw new ProtocolError("conflict", "该附件上传已被取消，无法继续");
  if (status.size !== checkpoint.size || status.sha256 !== checkpoint.sha256) {
    throw new ProtocolError("conflict", "服务端上传记录与检查点不一致");
  }

  emitStage(options, "hashing");
  checkAbort(options?.signal);
  await verifyFileIdentity(file, checkpoint, status, "resumeAttachment", options?.signal);
  if (status.offset >= status.size) {
    emitStage(options, "commit");
    checkAbort(options?.signal);
    return commitUpload(methods, checkpoint);
  }

  options?.onProgress?.(status.offset, status.size);
  emitStage(options, "sending");
  checkAbort(options?.signal);
  await writeChunks(methods, checkpoint, file, status.offset, options);
  checkAbort(options?.signal);
  emitStage(options, "commit");
  checkAbort(options?.signal);
  return commitUpload(methods, checkpoint);
}

/** Read-only reconciliation of an upload's current server state. */
export async function inspectAttachment(
  session: LiveSession,
  checkpoint: AttachmentCheckpoint,
  options?: AttachmentTransferOptions,
): Promise<UploadState> {
  validateAttachmentCheckpoint(checkpoint);
  const methods = requireCheckpointMethods(session, checkpoint);
  emitStage(options, "status");
  checkAbort(options?.signal); // a sync observer may abort before the RPC
  const status = await methods.workspaceUploadStatus(checkpoint.paneId, checkpoint.uploadId);
  stateMatchesCheckpoint(status, checkpoint, "WorkspaceUploadStatus");
  return status;
}

/** Explicit cancel mutation; attempted once and never retried automatically. */
export async function cancelAttachment(
  session: LiveSession,
  checkpoint: AttachmentCheckpoint,
): Promise<UploadState> {
  validateAttachmentCheckpoint(checkpoint);
  const methods = requireCheckpointMethods(session, checkpoint);
  const state = await methods.workspaceUploadCancel(checkpoint.paneId, checkpoint.uploadId);
  // Cancel of a committed file must be rejected by the server; a committed
  // reply here is a state mismatch, never an implied cancellation.
  if (state.state !== "cancelled") throw new ProtocolError("conflict", "WorkspaceUploadCancel 未终结上传");
  stateMatchesCheckpoint(state, checkpoint, "WorkspaceUploadCancel");
  return state;
}
