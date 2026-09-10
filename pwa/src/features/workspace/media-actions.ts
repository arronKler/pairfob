import { liveSession } from "../computers/catalog-store";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import type { MediaProgress, WorkspaceMediaLoader } from "./media-loader";
import {
  classifyWorkspaceFile,
  emptyMediaView,
  mediaCapBytes,
  mediaFilename,
  type WorkspaceFileRole,
  type WorkspaceMediaStatus,
  type WorkspaceMediaView,
} from "./media-model";
import { messageOf } from "../../lib/notices";
import {
  claimMediaGeneration,
  currentMediaGeneration,
  getWorkspaceSnapshot,
  issueTicket,
  workspaceMediaLoader,
} from "./store";

const MEDIA_PROGRESS_MS = 50;

/** Release the owned loader on component/scope unmount. Retires the current gen. */
export function releaseWorkspaceMedia(): void {
  const ticket = issueTicket({ content: "keep" });
  claimMediaGeneration();
  workspaceMediaLoader().cancel();
  ticket?.commit({ media: emptyMediaView() });
}

/** Reset media state when navigating away from a media-capable detail. */
export function clearWorkspaceMedia(): void {
  const ticket = issueTicket({ content: "keep" });
  claimMediaGeneration();
  workspaceMediaLoader().cancel();
  ticket?.commit({ media: { ...emptyMediaView() } });
}

/** Prepare media state for a newly opened file detail; cancels any prior load and
 *  claims a fresh media generation. Returns the true file role (text/svg/image/…).
 *  The generation it claimed is the currentMediaGeneration() value immediately
 *  after this synchronous call, so a caller can verify, after this notifying
 *  publication, that no newer media owner replaced it before auto-loading.
 *  text/svg are kept as their classified role (not coerced to download). */
export function prepareWorkspaceMedia(path: string, size: number): WorkspaceFileRole {
  const role = classifyWorkspaceFile(path);
  claimMediaGeneration();
  workspaceMediaLoader().cancel();
  const download = role === "download";
  const cap = mediaCapBytes(download ? "download" : role);
  const oversize = !download && role !== "text" && role !== "svg" && size > cap;
  const status: WorkspaceMediaStatus =
    oversize ? "oversize" : role === "image" ? "loading" : "idle";
  const ticket = issueTicket({ content: "keep" });
  ticket?.commit({
    media: {
      ...emptyMediaView(),
      path,
      role, // retain the classified role: text/svg are not coerced to download
      size,
      cap,
      kind: "",
      status,
    },
  });
  return role;
}

/** Mark a binary (no inline preview) download entry. */
export function markBinaryDownload(path: string, size: number): void {
  const cap = mediaCapBytes("download");
  const ticket = issueTicket({ content: "keep" });
  ticket?.commit({
    media: {
      ...emptyMediaView(),
      path,
      role: "download",
      status: size > cap ? "oversize" : "idle",
      kind: "download",
      mime: "application/octet-stream",
      size,
      cap,
    },
  });
}

function mediaErrorMessage(size: number, error: unknown): string {
  if (error instanceof ProtocolError && error.code === "unknown_op") return t("workspace.media.unsupportedDaemon");
  if (error instanceof ProtocolError && error.code === "too_large") {
    return t("workspace.media.oversizeFile", { size: String(size), cap: t("workspace.media.capMedia") });
  }
  if (error instanceof ProtocolError && error.code === "conflict") return t("workspace.media.changed");
  return messageOf(error);
}

function current(gen: number): boolean {
  const snap = getWorkspaceSnapshot();
  return currentMediaGeneration() === gen && Boolean(snap.paneId);
}

/**
 * Load an image/audio/video file through the owned media loader. Each operation
 * captures BOTH a content-scoped ticket AND its own media generation; after every
 * await and every publication (which can reenter) and before the next RPC/commit
 * it re-checks both, so a root/session/pane change, a newer detail, a loading-
 * publication retirement, or a fast switch cannot publish or even open for a stale
 * generation. Progress commits at 50 ms into the workspace store only.
 */
export async function loadWorkspaceMedia(path: string, gen?: number): Promise<boolean> {
  const session = liveSession();
  const paneId = getWorkspaceSnapshot().paneId;
  const loader = workspaceMediaLoader();
  if (!session?.workspaceMediaOpen || !paneId || !path) return false;
  // A caller that just prepared media passes the preparation's OWNER generation so
  // a stale autoload continuation cannot take a fresh ticket for a replaced pane.
  // A direct user load claims a fresh generation here.
  const g = gen ?? claimMediaGeneration();
  if (g !== currentMediaGeneration()) return false;
  const ticket = issueTicket({ content: "keep" });
  if (!ticket) return false;

  const base: WorkspaceMediaView = {
    ...getWorkspaceSnapshot().media,
    path,
    status: "loading",
    error: "",
    loaded: 0,
  };
  // The loading publication can reenter (a subscriber may begin a newer load or
  // retire the workspace). Re-check BEFORE any loader RPC so a stale operation
  // never opens a remote handle.
  if (!ticket.commit({ media: { ...base } })) return false;
  if (!ticket.current() || !current(g)) return false;

  let lastProgress = 0;
  const onProgress = (progress: MediaProgress): void => {
    if (!ticket.current() || currentMediaGeneration() !== g) return;
    const now = Date.now();
    if (now - lastProgress < MEDIA_PROGRESS_MS) return;
    lastProgress = now;
    const snap = getWorkspaceSnapshot().media;
    if (snap.path !== path) return;
    ticket.commit({ media: { ...snap, loaded: progress.loaded, size: progress.total || snap.size } });
  };

  try {
    const loaded = await loader.load(session, paneId, path, onProgress);
    // After the await: a retirement, fast switch or newer load invalidated this
    // generation/ticket; the loader already closes/disposes this operation's own
    // handle/URL, so never publish it (and never revoke a replacement URL).
    if (!ticket.current() || !ticket.sameContent() || currentMediaGeneration() !== g) {
      return false;
    }
    const snap = getWorkspaceSnapshot().media;
    const result: WorkspaceMediaView = {
      ...snap,
      // Keep the full workspace-relative path (used for reload/download), not the
      // basename; the view derives the download filename separately.
      path,
      status: "ready",
      kind: loaded.open.kind,
      mime: loaded.open.mime,
      size: loaded.open.size,
      loaded: loaded.open.size,
      cap: loaded.open.max_bytes,
      url: loaded.url,
      error: "",
      width: loaded.open.width,
      height: loaded.open.height,
      role: snap.role === "svg" ? "svg" : loaded.open.kind,
    };
    return ticket.commit({ media: result }) && currentMediaGeneration() === g;
  } catch (error) {
    // A stale/cancelled generation must not overwrite the current surface; the
    // owner error is only published for the live current generation, and then it
    // uses the ACTUAL failure mapped through the real media error set (unknown_op
    // -> update-daemon, too_large -> oversize, …). Never fabricate a conflict.
    if (!ticket.current() || currentMediaGeneration() !== g) return false;
    const snap = getWorkspaceSnapshot().media;
    ticket.commit({
      media: { ...snap, status: "error", error: mediaErrorMessage(snap.size, error) },
    });
    return false;
  }
}

/** Identity of the media currently shown, for late codec/pixel callbacks. */
export function mediaPlayerIdentity(): string {
  const m = getWorkspaceSnapshot().media;
  return `${m.path}:${m.url}:${m.status}`;
}

/** A media element failed to decode; offer download unless stale. */
export function markMediaCodecFailure(identity?: string): void {
  const snap = getWorkspaceSnapshot().media;
  if (identity && identity !== `${snap.path}:${snap.url}:ready`) return;
  const ticket = issueTicket({ content: "keep" });
  ticket?.commit({ media: { ...snap, status: "codec", error: t("workspace.media.codec") } });
}

/** A decoded image exceeded the pixel budget; offer download unless stale. */
export function markMediaPixelFailure(width: number, height: number, identity?: string): void {
  const snap = getWorkspaceSnapshot().media;
  if (identity && identity !== `${snap.path}:${snap.url}:ready`) return;
  const ticket = issueTicket({ content: "keep" });
  ticket?.commit({
    media: {
      ...snap,
      status: "oversize",
      width,
      height,
      error: t("workspace.media.oversizePixels", { width: String(width), height: String(height), max: "16" }),
    },
  });
}

export function mediaFileName(path: string): string {
  return mediaFilename(path);
}

export type { WorkspaceMediaLoader };
