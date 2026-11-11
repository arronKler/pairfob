/**
 * A large download on a browser without the File System Access API is served
 * by the app's service worker as a Content-Disposition response. The worker
 * cannot read the encrypted Pairfob session, so it pulls one chunk at a time
 * from this page over a BroadcastChannel. The page reads the RPC and posts the
 * chunk back; the worker's pull is the backpressure.
 */
import { isNativeRuntime } from "../../lib/runtime-config";

export const SERVICE_WORKER_DOWNLOAD_CHANNEL = "pairfob-download-v1";
export const SERVICE_WORKER_DOWNLOAD_ROUTE = "/__pairfob_download__/";
const DEFAULT_PULL_TIMEOUT_MS = 30_000;
const DONE_GRACE_MS = 5_000;

export type ServiceWorkerDownloadMeta = { name: string; size: number; mime: string };
export type ServiceWorkerDownloadChunk = { bytes: Uint8Array; eof: boolean };
export type ServiceWorkerDownloadSource = () => Promise<ServiceWorkerDownloadChunk>;

export type DownloadChannel = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export type DownloadFrame = {
  src: string;
  remove(): void;
  style?: { display: string };
};

export type DownloadPumpIO = {
  channel?: DownloadChannel;
  frame?: DownloadFrame;
  url?: string;
  origin?: string;
  id?: string;
  base?: string;
  timeoutMs?: number;
};

export type ServiceWorkerDownload = {
  promise: Promise<void>;
  cancel(): void;
};

function downloadID(): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  return [...raw].map(value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * The service worker's scope follows the page: the hosted app is at `/`, while
 * a phone that paired from `/pair` stays on `/pair`, where the worker is
 * registered with scope `/pair`. The download route must live inside it.
 */
export function downloadBasePath(pathname = typeof location === "undefined" ? "/" : location.pathname): string {
  return pathname === "/pair" || pathname.startsWith("/pair/") ? "/pair/" : "/";
}

function downloadURL(origin: string, id: string, meta: ServiceWorkerDownloadMeta, base: string): string {
  const url = new URL(`${base}${SERVICE_WORKER_DOWNLOAD_ROUTE.slice(1)}${id}`, origin);
  url.searchParams.set("name", meta.name);
  url.searchParams.set("size", String(meta.size));
  url.searchParams.set("mime", meta.mime);
  return url.toString();
}

function hiddenFrame(): DownloadFrame {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = "";
  document.body.appendChild(frame);
  return frame as unknown as DownloadFrame;
}

export function serviceWorkerDownloadSupported(): boolean {
  return typeof navigator !== "undefined"
    && Boolean(navigator.serviceWorker?.controller)
    && typeof BroadcastChannel === "function"
    && typeof ReadableStream === "function";
}

/**
 * The download route belongs to the app's service worker. A page loaded just
 * before the worker was activated has no controller yet; wait briefly instead
 * of failing the first download of a session.
 */
export async function ensureServiceWorkerControl(timeoutMs = 3_000): Promise<boolean> {
  if (isNativeRuntime()) return false;
  if (typeof navigator === "undefined" || !navigator.serviceWorker
    || typeof BroadcastChannel !== "function" || typeof ReadableStream !== "function") return false;
  if (navigator.serviceWorker.controller) return true;
  const scope = downloadBasePath() === "/pair/" ? "/pair" : "/";
  try { await navigator.serviceWorker.register("/sw.js", { scope }); } catch { return false; }
  if (navigator.serviceWorker.controller) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", change);
      resolve(value);
    };
    const change = () => done(true);
    const timer = setTimeout(() => done(Boolean(navigator.serviceWorker.controller)), timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", change);
    void navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) done(true);
    }).catch(() => done(false));
  });
}

export function startServiceWorkerDownload(
  meta: ServiceWorkerDownloadMeta,
  source: ServiceWorkerDownloadSource,
  io: DownloadPumpIO = {},
): ServiceWorkerDownload {
  const id = io.id || downloadID();
  const origin = io.origin || (typeof location === "undefined" ? "" : location.origin);
  const base = io.base || downloadBasePath();
  const channel = io.channel || (new BroadcastChannel(SERVICE_WORKER_DOWNLOAD_CHANNEL) as unknown as DownloadChannel);
  const frame = io.frame || hiddenFrame();
  const pullTimeout = io.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS;
  let settled = false;
  let cancelled = false;
  let reading = false;
  let pullTimer: ReturnType<typeof setTimeout> | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });

  const clearTimers = () => {
    if (pullTimer !== null) clearTimeout(pullTimer);
    if (doneTimer !== null) clearTimeout(doneTimer);
    pullTimer = null;
    doneTimer = null;
  };
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimers();
    channel.onmessage = null;
    try { channel.close(); } catch { /* already closed */ }
    try { frame.remove(); } catch { /* already removed */ }
    if (error) reject(error);
    else resolve();
  };
  const fail = (message: string) => {
    if (settled) return;
    try { channel.postMessage({ type: "error", id, message }); } catch { /* channel closed */ }
    finish(new Error(message));
  };
  const armPullTimeout = () => {
    if (settled) return;
    if (pullTimer !== null) clearTimeout(pullTimer);
    pullTimer = setTimeout(() => {
      if (!settled && !reading) fail("download_timeout");
    }, pullTimeout);
  };
  const pump = async () => {
    if (reading || settled || cancelled) return;
    reading = true;
    try {
      const chunk = await source();
      if (settled || cancelled) return;
      if (!(chunk.bytes instanceof Uint8Array)) {
        fail("download_invalid");
        return;
      }
      const view = chunk.bytes;
      const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      channel.postMessage({ type: "chunk", id, bytes: buffer, eof: chunk.eof }, [buffer]);
      if (chunk.eof) {
        if (pullTimer !== null) clearTimeout(pullTimer);
        pullTimer = null;
        // The worker sends `done` after closing its stream. If that message is
        // lost, the bytes are already handed over; do not strand the sheet.
        doneTimer = setTimeout(() => finish(), DONE_GRACE_MS);
      }
    } catch (error) {
      if (!settled && !cancelled) fail(error instanceof Error ? error.message : String(error));
    } finally {
      reading = false;
    }
  };

  channel.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || (data as { id?: unknown }).id !== id) return;
    const type = (data as { type?: unknown }).type;
    if (type === "start") return;
    if (type === "need") {
      armPullTimeout();
      void pump();
      return;
    }
    if (type === "done") {
      finish();
      return;
    }
    if (type === "error") {
      finish(new Error(typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message : "download_failed"));
      return;
    }
    if (type === "cancel") finish(new DOMException("取消下载", "AbortError"));
  };

  armPullTimeout();
  frame.src = io.url || downloadURL(origin, id, meta, base);
  return {
    promise,
    cancel() {
      if (settled) return;
      cancelled = true;
      try { channel.postMessage({ type: "cancel", id }); } catch { /* channel closed */ }
      finish(new DOMException("取消下载", "AbortError"));
    },
  };
}
