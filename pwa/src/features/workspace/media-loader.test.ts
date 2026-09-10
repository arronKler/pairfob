import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProtocolError } from "../../lib/protocol/errors";
import { MEDIA_CHUNK_BYTES, type WorkspaceMediaOpen } from "../../lib/protocol/workspace-media";
import { WorkspaceMediaLoader, type MediaSession } from "./media-loader";
import { classifyWorkspaceFile } from "./media-model";

const shaEmpty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function openResult(over: Partial<WorkspaceMediaOpen> = {}): WorkspaceMediaOpen {
  return {
    handle: "media_" + "c".repeat(32),
    path: "clip.bin",
    kind: "download",
    mime: "application/octet-stream",
    size: 3,
    modified_ms: 1,
    sha256: "",
    expires_ms: Date.now() + 60_000,
    chunk_bytes: MEDIA_CHUNK_BYTES,
    max_bytes: 32 * 1024 * 1024,
    max_pixels: 16_777_216,
    width: 0,
    height: 0,
    ...over,
  };
}

function session(bytes: Uint8Array, open: WorkspaceMediaOpen, hooks?: {
  onOpen?: () => void;
  onRead?: () => void;
  delayRead?: Promise<void>;
}): MediaSession & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    workspaceMediaOpen: async () => {
      hooks?.onOpen?.();
      return { ...open, size: bytes.length, sha256: open.sha256 };
    },
    workspaceMediaRead: async (_handle, offset, length) => {
      hooks?.onRead?.();
      if (hooks?.delayRead) await hooks.delayRead;
      const slice = bytes.subarray(offset, Math.min(bytes.length, offset + length));
      return { handle: open.handle, offset, length: slice.length, bytes: slice, eof: offset + slice.length >= bytes.length };
    },
    workspaceMediaClose: async (handle) => {
      closed.push(handle);
      return { handle, closed: true as const };
    },
  };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...view].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("workspace file classification", () => {
  test("keeps svg as source and images as auto-preview", () => {
    expect(classifyWorkspaceFile("a.ts")).toBe("text");
    expect(classifyWorkspaceFile("cat.PNG")).toBe("image");
    expect(classifyWorkspaceFile("clip.mp4")).toBe("video");
    expect(classifyWorkspaceFile("note.svg")).toBe("svg");
  });
});

describe("workspace media loader", () => {
  const urls: string[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  test("loads chunks, verifies the whole-file digest, and revokes on cancel", async () => {
    URL.createObjectURL = ((blob: Blob) => {
      const url = `blob:test/${urls.length}`;
      urls.push(url);
      expect(blob.size).toBe(3);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      const index = urls.indexOf(url);
      if (index >= 0) urls.splice(index, 1);
    }) as typeof URL.revokeObjectURL;
    const bytes = new Uint8Array([1, 2, 3]);
    const open = openResult({ sha256: await digest(bytes) });
    const api = session(bytes, open);
    const loader = new WorkspaceMediaLoader();
    const loaded = await loader.load(api, "p1", "clip.bin");
    expect(loaded.url).toBe("blob:test/0");
    expect(api.closed).toEqual([open.handle]);
    loader.cancel();
    expect(urls).toEqual([]);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  test("ignores a stale reply after a newer selection", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slowBytes = new Uint8Array([9, 9, 9]);
    const fastBytes = new Uint8Array([4, 5]);
    const slow = session(slowBytes, openResult({ handle: "media_" + "d".repeat(32), sha256: await digest(slowBytes) }), { delayRead: held });
    const fast = session(fastBytes, openResult({ handle: "media_" + "e".repeat(32), sha256: await digest(fastBytes) }));
    const loader = new WorkspaceMediaLoader();
    const first = loader.load(slow, "p1", "slow.bin");
    const second = loader.load(fast, "p1", "fast.bin");
    release();
    await expect(first).rejects.toBeInstanceOf(ProtocolError);
    const loaded = await second;
    expect(loaded.open.path).toBe("clip.bin");
    URL.revokeObjectURL(loaded.url);
  });

  test("maps unknown_op as itself rather than a generic failure", async () => {
    const loader = new WorkspaceMediaLoader();
    const api: MediaSession = {
      workspaceMediaOpen: async () => { throw new ProtocolError("unknown_op", "WorkspaceMediaOpen"); },
      workspaceMediaRead: async () => { throw new Error("should not read"); },
      workspaceMediaClose: async () => ({ handle: "media_" + "f".repeat(32), closed: true as const }),
    };
    try {
      await loader.load(api, "p1", "cat.png");
      throw new Error("expected unknown_op");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("unknown_op");
    }
  });

  test("aborts when the digest does not match the open hash", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    // shaEmpty (the empty-file hash) deliberately does NOT match [1,2,3], so the
    // loader must reject — preserving the original negative-case input.
    const api = session(bytes, openResult({ sha256: shaEmpty }));
    const loader = new WorkspaceMediaLoader();
    await expect(loader.load(api, "p1", "clip.bin")).rejects.toBeInstanceOf(ProtocolError);
    expect(api.closed).toEqual([openResult().handle]);
  });

  test("a late old Open cannot revoke a newer blob or skip closing its handle", async () => {
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => "blob:new") as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
    const closed: string[] = [];
    let resolveOld!: (value: WorkspaceMediaOpen) => void;
    const oldOpen = new Promise<WorkspaceMediaOpen>((resolve) => { resolveOld = resolve; });
    const emptySha = shaEmpty;
    const oldHandle = "media_" + "a".repeat(32);
    const newHandle = "media_" + "b".repeat(32);
    const api: MediaSession = {
      workspaceMediaOpen: async (_pane, path) => {
        if (path === "old.bin") return oldOpen;
        return openResult({ handle: newHandle, size: 0, sha256: emptySha, path: "new.bin" });
      },
      workspaceMediaRead: async () => { throw new Error("unused"); },
      workspaceMediaClose: async (handle) => { closed.push(handle); return { handle, closed: true as const }; },
    };
    const loader = new WorkspaceMediaLoader();
    const first = loader.load(api, "p1", "old.bin").catch((error) => error);
    const loaded = await loader.load(api, "p1", "new.bin");
    resolveOld(openResult({ handle: oldHandle, size: 0, sha256: emptySha, path: "old.bin" }));
    await first;
    expect(revoked).toEqual([]);
    expect(loader.currentURL()).toBe("blob:new");
    expect(closed).toContain(oldHandle);
    expect(closed).toContain(newHandle);
    expect(loaded.url).toBe("blob:new");
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
});

describe("loader player-cleanup lease", () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];

  beforeEach(() => {
    revoked.length = 0;
    URL.createObjectURL = (() => "blob:lease/" + revoked.length) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
  });
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  test("dispose runs registered player cleanup synchronously before revoking the URL", async () => {
    const loader = new WorkspaceMediaLoader();
    const bytes = new Uint8Array([1, 2, 3]);
    let closed = 0;
    const api: MediaSession & { closed: string[] } = {
      closed: [],
      workspaceMediaOpen: async () => openResult({ sha256: await digest(bytes) }),
      workspaceMediaRead: async () => ({ handle: "media_" + "c".repeat(32), offset: 0, length: 3, bytes, eof: true }),
      workspaceMediaClose: async (handle) => { closed++; return { handle, closed: true as const }; },
    };
    await loader.load(api, "p1", "clip.bin");
    const url = loader.currentURL();
    const events: string[] = [];
    const remove = loader.retainPlayerCleanup(() => events.push("cleanup"));
    expect(loader.currentURL()).toBe(url);
    loader.cancel();
    // Cleanup ran before the URL was revoked; then the handle was closed.
    expect(events[0]).toBe("cleanup");
    expect(revoked).toEqual([url]);
    expect(closed).toBe(1);
    remove();
  });

  test("unsubscribe removes only this registration", async () => {
    const loader = new WorkspaceMediaLoader();
    const bytes = new Uint8Array([1, 2, 3]);
    const api: MediaSession = {
      workspaceMediaOpen: async () => openResult({ sha256: await digest(bytes) }),
      workspaceMediaRead: async () => ({ handle: "media_" + "c".repeat(32), offset: 0, length: 3, bytes, eof: true }),
      workspaceMediaClose: async () => ({ handle: "media_" + "c".repeat(32), closed: true as const }),
    };
    await loader.load(api, "p1", "clip.bin");
    const calls: string[] = [];
    const removeA = loader.retainPlayerCleanup(() => calls.push("A"));
    const removeB = loader.retainPlayerCleanup(() => calls.push("B"));
    removeA();
    loader.cancel();
    expect(calls.filter((x) => x === "A")).toHaveLength(0);
    expect(calls.filter((x) => x === "B")).toHaveLength(1);
    removeB();
  });

  test("double dispose / StrictMode remount detaches idempotently", async () => {
    const loader = new WorkspaceMediaLoader();
    const bytes = new Uint8Array([1, 2, 3]);
    const api: MediaSession = {
      workspaceMediaOpen: async () => openResult({ sha256: await digest(bytes) }),
      workspaceMediaRead: async () => ({ handle: "media_" + "c".repeat(32), offset: 0, length: 3, bytes, eof: true }),
      workspaceMediaClose: async () => ({ handle: "media_" + "c".repeat(32), closed: true as const }),
    };
    await loader.load(api, "p1", "clip.bin");
    let cleans = 0;
    const remove = loader.retainPlayerCleanup(() => { cleans++; });
    // Simulate a remount that registers again on the same resource, then dispose
    // runs each registered cleanup once (StrictMode remount detach is harmless).
    const remove2 = loader.retainPlayerCleanup(() => { cleans++; });
    loader.cancel();
    expect(cleans).toBe(2);
    remove(); remove2();
    // After dispose the resource is gone; a later deregistration is a no-op.
    remove(); remove2();
    expect(cleans).toBe(2);
  });

  test("a throwing player cleanup does not block the remaining cleanups, the URL revoke, or the handle close", async () => {
    const loader = new WorkspaceMediaLoader();
    const bytes = new Uint8Array([1, 2, 3]);
    let closed = 0;
    const api: MediaSession = {
      workspaceMediaOpen: async () => openResult({ sha256: await digest(bytes) }),
      workspaceMediaRead: async () => ({ handle: "media_" + "c".repeat(32), offset: 0, length: 3, bytes, eof: true }),
      workspaceMediaClose: async () => { closed++; return { handle: "media_" + "c".repeat(32), closed: true as const }; },
    };
    await loader.load(api, "p1", "clip.bin");
    const url = loader.currentURL();
    const ran: string[] = [];
    loader.retainPlayerCleanup(() => { ran.push("boom"); throw new Error("detach failed"); });
    loader.retainPlayerCleanup(() => { ran.push("after"); });
    expect(() => loader.cancel()).not.toThrow();
    expect(ran).toEqual(["boom", "after"]);
    expect(revoked).toEqual([url]);
    expect(closed).toBe(1);
  });
});
