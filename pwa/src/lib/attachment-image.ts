/**
 * Public attachment image host API (main thread): compression AND thumbnails.
 *
 * Lifecycle and safety contract (frozen image-core):
 * - BOTH tasks share ONE global queue: at most 1 worker active and 4 queued
 *   across compression and thumbnail calls combined. A call that finds the
 *   cap full settles immediately without allocating a worker — compression
 *   returns the original (reason 'failed'), a thumbnail returns null. The
 *   active slot is held until the job really settles (reply / abort /
 *   timeout), then released and the queue drained;
 * - deadlines run from enqueue (including queue wait): 20s for compression,
 *   10s for thumbnails. Expiry settles the call (failed result / null);
 * - an already-aborted or subsequently-aborted signal rejects with AbortError
 *   immediately — even for size-bypassed inputs — never swallowed to a result;
 * - intent:'detail' bypasses compression entirely: right after the abort
 *   check the exact source File is returned (reason 'preserved') without
 *   queueing or allocating a worker (abort still takes precedence). The
 *   intent option NEVER grants provenance: only the explicit photo:true flag
 *   marks a PNG as JPEG-origin, so intent:'photo' on an arbitrary PNG keeps
 *   it preserved;
 * - a compressed result carries the worker-reported output width/height,
 *   which the host has validated as positive ints <= 2048;
 * - worker-unavailable (no Worker / constructor throw) and worker runtime
 *   error fall back to the original (reason 'unsupported') for compression
 *   and to null for thumbnails; no main-thread canvas fallback, ever;
 * - metadata (MIME + screenshot name) avoids allocating a worker for obvious
 *   preserved compression inputs; authoritative byte inspection still runs
 *   inside the worker. Thumbnails fast-reject only a confident non-JPEG/PNG
 *   MIME and inputs over 40 MiB;
 * - every worker reply is fully validated on the host: structural shape, job
 *   id tie, real Blob, MIME/type agreement, bounded size, bounded dims, and
 *   an actual byte signature read from the blob (async; the job is re-checked
 *   after the await and duplicate replies ignored). Compression rebuilds the
 *   output name from the trusted original filename, never from the worker.
 */
import {
  validateImageReply,
  type ImageTaskKind,
  type ImageWorkerReply,
  type ImageWorkerRequest,
} from "./attachment-image-protocol.ts";
import {
  MAX_OUTPUT_DIMENSION,
  MIN_IMAGE_BYTES,
  MIN_SAVING_RATIO,
  THUMBNAIL_MAX_OUTPUT_BYTES,
  THUMBNAIL_MAX_OUTPUT_DIMENSION,
  isScreenshotName,
  jpegExportName,
  preserveReason,
  sniffFormat,
  thumbnailRejectReason,
} from "./attachment-image-policy.ts";
import { newUUID } from "./ids";

export type AttachmentImageResult = {
  file: File;
  changed: boolean;
  originalBytes: number;
  reason: "compressed" | "small" | "preserved" | "unsupported" | "not-smaller" | "failed";
  /** Validated output dimensions; present only on a 'compressed' result. */
  width?: number;
  height?: number;
};

export type AttachmentImageOptions = {
  signal?: AbortSignal;
  /** Provenance: true only for a trusted edited PNG originally from a JPEG. */
  photo?: boolean;
  /**
   * Selects intent only — it never changes provenance. 'detail' keeps the
   * source byte-for-byte (no worker, reason 'preserved'); 'photo' is the
   * ordinary compression path for an eligible image.
   */
  intent?: "photo" | "detail";
};

export type AttachmentThumbnailOptions = {
  signal?: AbortSignal;
};

export const IMAGE_MAX_ACTIVE = 1;
export const IMAGE_MAX_QUEUED = 4;
export const IMAGE_DEADLINE_MS = 20_000;
export const THUMBNAIL_DEADLINE_MS = 10_000;

/** Minimal structural worker surface; the DOM Worker satisfies it directly. */
export type ImageWorkerHandle = {
  postMessage(message: ImageWorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
};

/** Test-only seams. Production callers always use the public APIs. */
export type AttachmentImageInternals = {
  createWorker?: () => ImageWorkerHandle;
  deadlineMs?: number;
};

let internals: AttachmentImageInternals = {};
export function __setImageInternals(value: AttachmentImageInternals): void {
  internals = value;
}
export function __resetImageInternals(): void {
  internals = {};
}

/** What a settled job resolves with, depending on its task. */
type JobOutput = AttachmentImageResult | Blob | null;

type ImageJob = {
  task: ImageTaskKind;
  file: File;
  photo: boolean;
  signal?: AbortSignal;
  resolve: (value: JobOutput) => void;
  reject: (error: unknown) => void;
  worker: ImageWorkerHandle | null;
  workerMessage?: (event: MessageEvent) => void;
  workerError?: () => void;
  deadline?: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  settled: boolean;
  /** True while the first reply is being validated (skip later duplicates). */
  validating: boolean;
  /** True while this job owns the single active slot (created its worker). */
  started: boolean;
};

let activeCount = 0;
const queue: ImageJob[] = [];

function abortError(): DOMException {
  return new DOMException("附件处理已取消", "AbortError");
}

function makeResult(file: File, reason: AttachmentImageResult["reason"]): AttachmentImageResult {
  return { file, changed: false, originalBytes: file.size, reason };
}

/** Fallback value for an unsupported/failed settlement of each task. */
function fallback(job: ImageJob, reason: "unsupported" | "failed"): JobOutput {
  return job.task === "thumbnail" ? null : makeResult(job.file, reason);
}

function removeQueued(job: ImageJob): void {
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
}

function cleanupJob(job: ImageJob): void {
  if (job.deadline !== undefined) clearTimeout(job.deadline);
  job.signal?.removeEventListener("abort", job.onAbort);
  const worker = job.worker;
  if (worker) {
    if (job.workerMessage) worker.removeEventListener("message", job.workerMessage);
    if (job.workerError) worker.removeEventListener("error", job.workerError);
    worker.terminate();
    job.worker = null;
  }
  job.workerMessage = undefined;
  job.workerError = undefined;
}

/**
 * Release the active slot (exactly once) when a started job settles, then
 * drain the queue. Called from the settle choke points.
 */
function releaseSlot(job: ImageJob): void {
  if (!job.started) return;
  job.started = false;
  activeCount -= 1;
  pump();
}

function removeQueuedAndRelease(job: ImageJob): void {
  removeQueued(job);
  releaseSlot(job);
}

function finish(job: ImageJob, value: JobOutput): void {
  if (job.settled) return;
  job.settled = true;
  job.validating = false;
  cleanupJob(job);
  removeQueuedAndRelease(job);
  job.resolve(value);
}

/** Compression-only settlement with a concrete image result. */
function settleResolve(job: ImageJob, result: AttachmentImageResult): void {
  finish(job, result);
}

/** Thumbnail settlement with a validated blob (or null on every failure). */
function settleThumbnail(job: ImageJob, blob: Blob | null): void {
  finish(job, blob);
}

function settleAbort(job: ImageJob): void {
  if (job.settled) return;
  job.settled = true;
  job.validating = false;
  cleanupJob(job);
  removeQueuedAndRelease(job);
  job.reject(abortError());
}

function settleUnsupported(job: ImageJob): void {
  finish(job, fallback(job, "unsupported"));
}

function settleFail(job: ImageJob): void {
  finish(job, fallback(job, "failed"));
}

function handleAbort(job: ImageJob): void {
  settleAbort(job);
}

function handleDeadline(job: ImageJob): void {
  settleFail(job);
}

function createDefaultWorker(): ImageWorkerHandle {
  return new Worker(
    new URL("./attachment-image.worker.ts", import.meta.url),
    { type: "module" },
  ) as unknown as ImageWorkerHandle;
}

function newJobId(): string {
  return newUUID();
}

function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
}

/**
 * Fully validate a compressed reply on the host, including the async JPEG
 * byte-signature read. Resolves with an AttachmentImageResult, or null when
 * the reply must be treated as malformed (fail closed to the original).
 */
async function verifyCompressed(
  job: ImageJob,
  reply: Extract<ImageWorkerReply, { kind: "compressed" }>,
): Promise<AttachmentImageResult | null> {
  if (reply.mime !== "image/jpeg") return null;
  if (reply.blob.size <= 0) return null;
  if (reply.blob.size > job.file.size) return null; // never bigger than input
  if (reply.blob.size > job.file.size * (1 - MIN_SAVING_RATIO)) return null; // < 10% saving
  if (!Number.isSafeInteger(reply.width) || !Number.isSafeInteger(reply.height)) return null;
  if (reply.width > MAX_OUTPUT_DIMENSION || reply.height > MAX_OUTPUT_DIMENSION) return null;
  if (reply.width <= 0 || reply.height <= 0) return null;
  // Actual JPEG bytes from the blob (async) — never trust the worker's claim.
  let head: Uint8Array;
  try {
    head = new Uint8Array(await reply.blob.slice(0, 3).arrayBuffer());
  } catch {
    return null;
  }
  // The job may have settled (reply/abort/timeout) during the await.
  if (job.settled) return null;
  if (job.signal?.aborted) {
    // A late abort may not have delivered the listener yet; settle it now.
    if (!job.settled) settleAbort(job);
    return null;
  }
  if (!isJpegSignature(head)) return null;
  // Output name rebuilt from the TRUSTED original filename.
  const output = new File([reply.blob], jpegExportName(job.file.name), {
    type: "image/jpeg",
    lastModified: job.file.lastModified,
  });
  return {
    file: output,
    changed: true,
    originalBytes: job.file.size,
    reason: "compressed",
    // Actual validated output dims from the worker reply (bounds checked
    // structurally in validateImageReply and again above).
    width: reply.width,
    height: reply.height,
  };
}

/**
 * Fully validate a thumbnail reply on the host, including the async
 * MIME-matching byte-signature read. Returns the worker Blob on success or
 * null when anything is malformed or out of bounds (caller keeps no thumb).
 */
async function verifyThumbnail(
  job: ImageJob,
  reply: Extract<ImageWorkerReply, { kind: "thumbnail" }>,
): Promise<Blob | null> {
  if (reply.mime !== "image/jpeg" && reply.mime !== "image/png") return null;
  if (reply.blob.type !== reply.mime) return null;
  if (reply.blob.size <= 0 || reply.blob.size > THUMBNAIL_MAX_OUTPUT_BYTES) return null;
  if (!Number.isSafeInteger(reply.width) || !Number.isSafeInteger(reply.height)) return null;
  if (reply.width <= 0 || reply.height <= 0) return null;
  if (
    reply.width > THUMBNAIL_MAX_OUTPUT_DIMENSION ||
    reply.height > THUMBNAIL_MAX_OUTPUT_DIMENSION
  ) {
    return null;
  }
  let head: Uint8Array;
  try {
    head = new Uint8Array(await reply.blob.slice(0, 8).arrayBuffer());
  } catch {
    return null;
  }
  if (job.settled) return null;
  if (job.signal?.aborted) {
    if (!job.settled) settleAbort(job);
    return null;
  }
  // Real bytes must agree with the claimed MIME (sniffFormat is authoritative).
  if (sniffFormat(head) !== (reply.mime === "image/png" ? "png" : "jpeg")) return null;
  return reply.blob;
}

/** Successful (ok:true) worker replies; error replies settle before this. */
type ImageWorkerOkReply = Extract<ImageWorkerReply, { ok: true }>;

/** Route a validated successful reply according to the job's task. */
function dispatchReply(job: ImageJob, reply: ImageWorkerOkReply): void {
  if (job.task === "thumbnail") {
    if (reply.kind !== "thumbnail") {
      settleThumbnail(job, null); // wrong kind for this task -> no thumbnail
      return;
    }
    void verifyThumbnail(job, reply).then((blob) => {
      if (blob === null) {
        if (!job.settled) settleFail(job);
        return;
      }
      settleThumbnail(job, blob);
    });
    return;
  }
  // Compression task.
  switch (reply.kind) {
    case "compressed":
      void verifyCompressed(job, reply).then((result) => {
        if (result === null) {
          if (!job.settled) settleFail(job);
          return;
        }
        settleResolve(job, result);
      });
      break;
    case "thumbnail":
      settleFail(job); // image tasks never receive thumbnail replies
      break;
    case "preserved":
      settleResolve(job, makeResult(job.file, "preserved"));
      break;
    case "unsupported":
      settleResolve(job, makeResult(job.file, "unsupported"));
      break;
    case "not-smaller":
      settleResolve(job, makeResult(job.file, "not-smaller"));
      break;
    case "failed":
      settleResolve(job, makeResult(job.file, "failed"));
      break;
  }
}

/** Start a job: create worker, post the request, and wait for settlement. */
function startJob(job: ImageJob): void {
  if (job.settled || job.validating) {
    // Aborted/deadlined while queued: never allocate a worker for it.
    return;
  }
  const create = internals.createWorker ?? createDefaultWorker;
  let worker: ImageWorkerHandle;
  try {
    worker = create();
  } catch {
    // No Worker constructor / CSP / quota -> unsupported, no fallback.
    settleUnsupported(job);
    return;
  }
  if (job.settled) {
    worker.terminate(); // aborted/deadline fired during construction
    return;
  }
  job.worker = worker;
  const request: ImageWorkerRequest = {
    jobId: newJobId(),
    file: job.file,
    photo: job.photo,
    task: job.task,
  };

  const onMessage = (event: MessageEvent): void => {
    // Settled or already-validating jobs ignore further messages.
    if (job.settled || job.validating) return;
    job.validating = true;
    const reply = event.data as ImageWorkerReply;
    const problem = validateImageReply(reply, request, job.file.size);
    if (problem !== null) {
      settleFail(job); // malformed / out-of-bounds structural reply -> fail closed
      return;
    }
    if (!reply.ok) {
      settleUnsupported(job);
      return;
    }
    dispatchReply(job, reply);
  };

  const onError = (): void => {
    if (job.settled) return;
    settleUnsupported(job); // worker runtime error -> fallback, no canvas fallback
  };

  job.workerMessage = onMessage;
  job.workerError = onError;
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  if (job.signal?.aborted) {
    settleAbort(job);
    return;
  }
  try {
    worker.postMessage(request);
  } catch {
    settleUnsupported(job);
  }
}

/** Drain the queue while an active slot is free. Jobs already settled are
 *  dropped without taking a slot, so an expired queued job cannot wedge. */
function pump(): void {
  while (activeCount < IMAGE_MAX_ACTIVE && queue.length > 0) {
    const job = queue.shift();
    if (!job) return;
    if (job.settled || job.validating) continue; // skip settled/claimed jobs
    job.started = true;
    activeCount += 1;
    startJob(job);
  }
}

/**
 * Shared enqueue for both tasks: arm the abort listener, enforce the
 * IMAGE_MAX_ACTIVE + IMAGE_MAX_QUEUED cap, then pump. Caller owns the
 * deadline (task-specific) and must have handled an already-aborted signal.
 */
function enqueue(job: ImageJob): void {
  if (job.signal?.aborted) {
    settleAbort(job);
    return;
  }
  job.signal?.addEventListener("abort", job.onAbort, { once: true });

  const pending = activeCount + queue.length;
  if (pending >= IMAGE_MAX_ACTIVE + IMAGE_MAX_QUEUED) {
    settleFail(job); // cap full -> settle without allocating a worker
    return;
  }
  queue.push(job);
  pump();
}

export function prepareAttachmentImage(
  file: File,
  options?: AttachmentImageOptions,
): Promise<AttachmentImageResult> {
  const signal = options?.signal;
  // An already-aborted signal must reject even for size-bypassed inputs.
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  // Detail intent: keep the exact source, before any queue/metadata/worker work.
  if (options?.intent === "detail") {
    return Promise.resolve({ file, changed: false, originalBytes: file.size, reason: "preserved" });
  }
  // Provenance comes ONLY from the explicit photo flag. intent:'photo' on an
  // arbitrary PNG must not be treated as a trusted JPEG-origin PNG.
  const photo = options?.photo === true;
  const originalBytes = file.size;
  const metadata = preserveReason({ name: file.name, type: file.type, size: originalBytes }, photo);
  // Metadata fast-path: small bypass and confident preservation need no worker.
  if (metadata === "small") {
    return Promise.resolve({ file, changed: false, originalBytes, reason: "small" });
  }
  if (metadata === "preserved") {
    return Promise.resolve({ file, changed: false, originalBytes, reason: "preserved" });
  }
  // Screenshot names are preserved even for JPEG bytes (kept, no worker).
  if (isScreenshotName(file.name)) {
    return Promise.resolve({ file, changed: false, originalBytes, reason: "preserved" });
  }
  return new Promise<AttachmentImageResult>((resolve, reject) => {
    const job: ImageJob = {
      task: "image",
      file,
      photo,
      signal,
      resolve: resolve as (value: JobOutput) => void,
      reject,
      worker: null,
      deadline: undefined,
      onAbort: () => {},
      settled: false,
      validating: false,
      started: false,
    };
    job.onAbort = () => handleAbort(job);
    // 20s deadline from enqueue, including queue wait.
    job.deadline = setTimeout(() => handleDeadline(job), internals.deadlineMs ?? IMAGE_DEADLINE_MS);
    enqueue(job);
  });
}

/**
 * Produce a bounded thumbnail Blob (long edge <= 128; PNG alpha preserved for
 * PNG input, JPEG q.75 for JPEG input; <= 128 KiB) through the SHARED image
 * queue — never a second decode queue and never a main-thread canvas.
 *
 * Resolves null on every non-abort failure: fast-rejected MIME/size, queue
 * overflow, timeout, worker error, malformed reply, or bounds violation. An
 * aborted signal rejects with AbortError (abort takes precedence).
 */
export function prepareAttachmentThumbnail(
  file: File,
  options?: AttachmentThumbnailOptions,
): Promise<Blob | null> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  // Host fast gate: confident non-JPEG/PNG MIME and > 40 MiB never enqueue.
  if (thumbnailRejectReason(file) !== null) {
    return Promise.resolve(null);
  }
  return new Promise<Blob | null>((resolve, reject) => {
    const job: ImageJob = {
      task: "thumbnail",
      file,
      photo: false, // thumbnails never carry editing provenance
      signal,
      resolve: resolve as (value: JobOutput) => void,
      reject,
      worker: null,
      deadline: undefined,
      onAbort: () => {},
      settled: false,
      validating: false,
      started: false,
    };
    job.onAbort = () => handleAbort(job);
    // 10s thumbnail deadline from enqueue, including queue wait.
    job.deadline = setTimeout(
      () => handleDeadline(job),
      internals.deadlineMs ?? THUMBNAIL_DEADLINE_MS,
    );
    enqueue(job);
  });
}
