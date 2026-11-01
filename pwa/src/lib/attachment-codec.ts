/**
 * Off-main-thread SHA-256 hashing and canonical base64 encoding for
 * attachment uploads (P4 local file CPU work).
 *
 * Public API (frozen for the transfer layer to integrate later):
 *   hashAttachmentOffThread(file, signal?) -> lowercase hex SHA-256
 *   encodeAttachmentChunk(file, offset, end, signal?) -> canonical base64
 *
 * Lifecycle guarantees:
 * - ONE short-lived module worker per invocation, terminated exactly once on
 *   settle, abort, startup failure or watchdog timeout;
 * - at most 4 codec jobs run at once; up to 8 callers may wait; the 13th gets
 *   an actionable backpressure rejection instead of an unbounded queue;
 * - worker unavailable / constructor throw / worker runtime `error` event fall
 *   back exactly once to bounded cooperative main-thread work — never after a
 *   user abort, never retried, file read failures surface;
 * - a 45s watchdog fails a hung worker with an actionable timeout;
 * - no caches of File or bytes at module scope.
 */
import { ProtocolError } from "./protocol/errors.ts";
import {
  checkCodecAbort,
  codecAbortError,
  encodeChunkCore,
  hashFileCore,
  validateCodecFile,
  validateCodecRange,
} from "./attachment-codec-core.ts";
import {
  CODEC_OP_B64CHUNK,
  CODEC_OP_SHA256,
  isCodecOkReply,
  validateCodecReply,
  type CodecB64ChunkRequest,
  type CodecReply,
  type CodecRequest,
  type CodecSha256Request,
} from "./attachment-codec-protocol.ts";
import { newUUID } from "./ids";

export const CODEC_MAX_ACTIVE_JOBS = 4;
export const CODEC_MAX_WAITING_JOBS = 8;
export const CODEC_WATCHDOG_MS = 45_000;

/** Minimal structural worker surface; the DOM Worker satisfies it directly. */
export type CodecWorkerHandle = {
  postMessage(message: CodecRequest): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
};

/** Test-only seams. Production callers always use the 2-argument public API. */
export type CodecInternals = {
  /** Override worker construction (fakes); absent => the bundled module worker. */
  createWorker?: () => CodecWorkerHandle;
  /** Watchdog deadline in milliseconds (fakes run fast). */
  watchdogMs?: number;
};

// --- Bounded pool -------------------------------------------------------------------

type Waiter = {
  grant(): void;
  remove(): void;
};

let activeJobs = 0;
const waitingJobs: Waiter[] = [];

function backpressureError(): ProtocolError {
  return new ProtocolError("backpressure", "附件处理繁忙，请稍后再试");
}

async function acquireJobSlot(signal?: AbortSignal): Promise<() => void> {
  if (activeJobs < CODEC_MAX_ACTIVE_JOBS) {
    activeJobs += 1;
    return releaseJobSlot;
  }
  if (waitingJobs.length >= CODEC_MAX_WAITING_JOBS) throw backpressureError();
  checkCodecAbort(signal);
  // Ownership of a running slot is transferred by releaseJobSlot: a granted
  // waiter must NOT increment activeJobs again (the releasing job skipped its
  // own decrement when it handed the slot over).
  await new Promise<void>((resolve, reject) => {
    let waiter: Waiter;
    const onAbort = (): void => {
      const index = waitingJobs.indexOf(waiter);
      if (index >= 0) waitingJobs.splice(index, 1);
      reject(codecAbortError());
    };
    waiter = {
      grant() {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      remove: onAbort,
    };
    waitingJobs.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return releaseJobSlot;
}

function releaseJobSlot(): void {
  const next = waitingJobs.shift();
  if (next) next.grant(); // slot ownership transfers; active count stays
  else activeJobs -= 1;
}

// --- Public validation --------------------------------------------------------------

function assertValidFile(file: File): void {
  try {
    validateCodecFile(file);
  } catch (error) {
    const tooLarge = error instanceof TypeError && error.message.includes("20 MiB");
    throw new ProtocolError(tooLarge ? "too_large" : "invalid_argument",
      error instanceof Error ? error.message : "附件非法");
  }
}

function assertValidRange(file: File, offset: number, end: number): void {
  assertValidFile(file);
  try {
    validateCodecRange(file, offset, end);
  } catch (error) {
    throw new ProtocolError("invalid_argument", error instanceof Error ? error.message : "分片范围非法");
  }
}

// --- One worker invocation ----------------------------------------------------------

/** Vite-recognised module worker; one instance per invocation. */
function createDefaultWorker(): CodecWorkerHandle {
  return new Worker(
    new URL("./attachment-codec.worker.ts", import.meta.url),
    { type: "module" },
  ) as unknown as CodecWorkerHandle;
}

/** Distinguishes "worker cannot run" (fall back) from real failures. */
class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

function newJobId(): string {
  return newUUID();
}

async function invokeOnce(
  request: CodecRequest,
  byteLength: number,
  cooperativeFallback: () => Promise<string>,
  signal: AbortSignal | undefined,
  internals: CodecInternals,
): Promise<string> {
  checkCodecAbort(signal);
  if (!internals.createWorker && typeof Worker === "undefined") {
    // No Worker constructor at all: bounded cooperative path immediately.
    return cooperativeFallback();
  }
  let worker: CodecWorkerHandle;
  try {
    worker = (internals.createWorker ?? createDefaultWorker)();
  } catch {
    checkCodecAbort(signal);
    return cooperativeFallback(); // constructor threw (CSP/browser/quota)
  }

  const job = new Promise<string>((resolve, reject) => {
    let settled = false;
    let terminated = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const terminateOnce = (): void => {
      if (!terminated) {
        terminated = true;
        worker.terminate();
      }
    };

    const onMessage = (event: MessageEvent): void => {
      if (settled) return;
      const reply = event.data as CodecReply;
      const problem = validateCodecReply(reply, request, byteLength);
      if (problem) {
        settleReject(new ProtocolError("internal", "附件处理响应异常，请重试"));
        return;
      }
      if (isCodecOkReply(reply)) settleResolve(reply.result);
      else settleReject(new Error(reply.error.message));
    };

    const onError = (): void => {
      if (settled) return; // late crash after the reply is irrelevant
      settleReject(new WorkerUnavailableError("codec worker could not run"));
    };

    const onAbort = (): void => settleReject(codecAbortError());

    const detach = (): void => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (watchdog !== undefined) clearTimeout(watchdog);
    };

    const settleResolve = (value: string): void => {
      if (settled) return;
      settled = true;
      detach();
      terminateOnce();
      resolve(value);
    };

    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      detach();
      terminateOnce();
      reject(error);
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    if (signal) {
      if (signal.aborted) {
        settleReject(codecAbortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    watchdog = setTimeout(() => {
      settleReject(new ProtocolError("timeout", "附件处理超时，请重试"));
    }, internals.watchdogMs ?? CODEC_WATCHDOG_MS);

    try {
      worker.postMessage(request); // File crosses by structured clone
    } catch {
      if (signal?.aborted) settleReject(codecAbortError());
      else settleReject(new WorkerUnavailableError("codec worker rejected the file"));
    }
  });

  return job.catch((error: unknown) => {
    // Exactly one cooperative retry, only when the worker itself could not run
    // and the user never asked to cancel.
    if (error instanceof WorkerUnavailableError && !signal?.aborted) return cooperativeFallback();
    throw error;
  });
}

// --- Public API ---------------------------------------------------------------------

export async function hashAttachmentOffThread(
  file: File,
  signal?: AbortSignal,
  internals: CodecInternals = {},
): Promise<string> {
  assertValidFile(file);
  checkCodecAbort(signal);
  const release = await acquireJobSlot(signal);
  try {
    const request: CodecSha256Request = { jobId: newJobId(), op: CODEC_OP_SHA256, file };
    return await invokeOnce(request, file.size, () => hashFileCore(file, signal), signal, internals);
  } finally {
    release();
  }
}

export async function encodeAttachmentChunk(
  file: File,
  offset: number,
  end: number,
  signal?: AbortSignal,
  internals: CodecInternals = {},
): Promise<string> {
  assertValidRange(file, offset, end);
  checkCodecAbort(signal);
  const release = await acquireJobSlot(signal);
  try {
    const request: CodecB64ChunkRequest = { jobId: newJobId(), op: CODEC_OP_B64CHUNK, file, offset, end };
    return await invokeOnce(request, end - offset, () => encodeChunkCore(file, offset, end, signal), signal, internals);
  } finally {
    release();
  }
}
