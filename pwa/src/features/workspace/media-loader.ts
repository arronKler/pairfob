import { ProtocolError } from "../../lib/protocol/errors";
import {
  MEDIA_CHUNK_BYTES,
  imageExceedsPixelBudget,
  type WorkspaceMediaKind,
  type WorkspaceMediaOpen,
} from "../../lib/protocol/workspace-media";

export type MediaSession = {
  workspaceMediaOpen: (paneId: string, path: string) => Promise<WorkspaceMediaOpen>;
  workspaceMediaRead: (handle: string, offset: number, length: number) => Promise<{
    handle: string; offset: number; length: number; bytes: Uint8Array; eof: boolean;
  }>;
  workspaceMediaClose: (handle: string) => Promise<unknown>;
};

export type LoadedMedia = {
  open: WorkspaceMediaOpen;
  blob: Blob;
  url: string;
};

export type MediaProgress = { loaded: number; total: number };

type LoadResources = {
  generation: number;
  session: MediaSession;
  handle: string;
  url: string;
  abort: AbortController;
  /** Owned player element cleanups, run synchronously BEFORE the URL is revoked. */
  releasePlayer: Array<() => void>;
};

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hexSha256(buffer: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", buffer).then((digest) => {
    const view = new Uint8Array(digest);
    return [...view].map((value) => value.toString(16).padStart(2, "0")).join("");
  });
}

export class WorkspaceMediaLoader {
  private generation = 0;
  private current: LoadResources | null = null;

  currentURL(): string {
    return this.current?.url ?? "";
  }

  cancel(): void {
    this.generation += 1;
    const previous = this.current;
    this.current = null;
    previous?.abort.abort();
    this.dispose(previous, true);
  }

  release(): void {
    this.cancel();
  }

  async load(
    session: MediaSession,
    paneId: string,
    path: string,
    onProgress?: (progress: MediaProgress) => void,
    signal?: AbortSignal,
  ): Promise<LoadedMedia> {
    const mine = this.begin(session);
    const onAbort = () => mine.abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (mine.abort.signal.aborted) throw cancelled();
      const open = await session.workspaceMediaOpen(paneId, path);
      mine.handle = open.handle;
      if (!this.isCurrent(mine)) {
        this.dispose(mine, true);
        throw cancelled();
      }
      if (imageExceedsPixelBudget(open.width, open.height, open.max_pixels)) {
        throw new ProtocolError("too_large", "image exceeds decode pixel limit");
      }
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let eof = open.size === 0;
      onProgress?.({ loaded: 0, total: open.size });
      while (!eof) {
        if (!this.isCurrent(mine)) throw cancelled();
        const chunk = await session.workspaceMediaRead(open.handle, offset, MEDIA_CHUNK_BYTES);
        if (!this.isCurrent(mine)) throw cancelled();
        if (chunk.handle !== open.handle || chunk.offset !== offset) {
          throw new ProtocolError("conflict", "media chunk offset mismatch");
        }
        chunks.push(chunk.bytes);
        offset += chunk.length;
        eof = chunk.eof;
        onProgress?.({ loaded: offset, total: open.size });
        if (offset > open.size) throw new ProtocolError("too_large", "media chunk exceeded declared size");
      }
      if (offset !== open.size) throw new ProtocolError("conflict", "media size mismatch");
      const bytes = concat(chunks, offset);
      const buffer = asBuffer(bytes);
      const digest = await hexSha256(buffer);
      if (!this.isCurrent(mine)) throw cancelled();
      if (digest !== open.sha256) throw new ProtocolError("conflict", "media digest mismatch");
      const blob = new Blob([buffer], { type: blobType(open.kind, open.mime) });
      const url = URL.createObjectURL(blob);
      mine.url = url;
      this.closeHandle(mine);
      if (!this.isCurrent(mine)) {
        this.dispose(mine, true);
        throw cancelled();
      }
      return { open, blob, url };
    } catch (error) {
      this.dispose(mine, true);
      if (this.current === mine) this.current = null;
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private begin(session: MediaSession): LoadResources {
    this.generation += 1;
    const mine: LoadResources = {
      generation: this.generation, session, handle: "", url: "", abort: new AbortController(),
      releasePlayer: [],
    };
    const previous = this.current;
    this.current = mine;
    previous?.abort.abort();
    this.dispose(previous, true);
    return mine;
  }

  private isCurrent(mine: LoadResources): boolean {
    return this.current === mine && mine.generation === this.generation && !mine.abort.signal.aborted;
  }

  private dispose(resources: LoadResources | null, revokeURL: boolean): void {
    if (!resources) return;
    // Detach the owned player element(s) synchronously BEFORE revoking the URL
    // they reference (original requirement: pause + clear src before revoke).
    // The mounted view registers these via retainPlayerCleanup. A throwing
    // cleanup must never block the remaining handle close / URL revoke.
    const players = resources.releasePlayer;
    resources.releasePlayer = [];
    for (const cleanup of players) {
      try {
        cleanup();
      } catch {
        /* non-blocking */
      }
    }
    if (revokeURL && resources.url) {
      URL.revokeObjectURL(resources.url);
      resources.url = "";
    }
    this.closeHandle(resources);
  }

  /**
   * Register an owned player-element cleanup for the CURRENT resource and return
   * an unsubscribe. The loader runs every registered cleanup synchronously when
   * the resource is disposed, immediately before the blob URL is revoked, so a
   * rendered player is paused and its src detached before the URL it loaded dies.
   *
   * Ownership is per resource: a cleanup registered for an older resource can
   * never clear a NEWER resource's URL, because dispose only ever calls the
   * current resource's own list. Re-registration stacks (a StrictMode
   * remount / double dispose detaches harmlessly); removePlayerCleanup removes
   * only this registration.
   */
  retainPlayerCleanup(cleanup: () => void): () => void {
    const current = this.current;
    if (!current) return () => undefined;
    current.releasePlayer.push(cleanup);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (current.releasePlayer.includes(cleanup)) {
        current.releasePlayer = current.releasePlayer.filter((fn) => fn !== cleanup);
      }
    };
  }

  private closeHandle(resources: LoadResources): void {
    const handle = resources.handle;
    resources.handle = "";
    if (!handle) return;
    void resources.session.workspaceMediaClose(handle).catch(() => undefined);
  }
}

function cancelled(): ProtocolError {
  return new ProtocolError("conflict", "media load cancelled");
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function blobType(kind: WorkspaceMediaKind, mime: string): string {
  if (kind === "download" && mime === "image/svg+xml") return "application/octet-stream";
  return mime;
}
