import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../lib/protocol/client";
import { ProtocolError } from "../../lib/protocol/errors";
import { MEDIA_CHUNK_BYTES } from "../../lib/protocol/workspace-media";
import { setLang } from "../../lib/i18n";

const { appRoot } = await import("../../app/dom-root.ts");
const { appHost, isAppMounted, mountApp, unmountApp } = await import("../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../app/frame.ts");
const { registerSessionView } = await import("../session/register.ts");
const { resetTransitionState } = await import("../../app/transition.ts");
const { setPhase } = await import("../connection/connection-store.ts");
const { setScreen } = await import("../../app/navigation-store.ts");
const { resetPaneView, selectPane } = await import("../session/session-store.ts");
const { attachLiveSession } = await import("../computers/catalog-store.ts");
const { applySnapshot } = await import("../dashboard/catalog-store.ts");
const {
  clearWorkspacePendingReveal, enterWorkspace, getWorkspaceSnapshot, subscribeWorkspace,
} = await import("./index.ts");
const { loadWorkspaceFile, closeWorkspaceDetail } = await import("./actions.ts");
const { loadWorkspaceMedia, markMediaCodecFailure, mediaPlayerIdentity } = await import("./media-actions.ts");
const { resetWorkspaceNavigationSeam } = await import("./navigation.ts");

const root = appRoot();
const testSnapshotRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const handle = "media_" + "a".repeat(32);
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const pngSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", png))]
  .map((value) => value.toString(16).padStart(2, "0")).join("");

function liveFixture(): LiveSession {
  return {
    isConnected: () => true,
    workspaceOpen: async () => ({
      name: "pairfob",
      root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: "pairfob", branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async () => ({
      path: "",
      entries: [{ name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null, truncated: false, revision,
    }),
    workspaceRead: async (_pane: string, path: string) =>
      path.includes(".png") || path.includes(".mp4")
        ? { path, kind: "binary" as const, size: png.length, modified_ms: 1, content: "", truncated: false, revision }
        : { path, kind: "text" as const, size: 25, modified_ms: 1, content: "export const ready = true;\n", truncated: false, revision },
    workspaceMediaOpen: async (_pane: string, path: string) => ({
      handle, path, kind: path.includes(".mp4") ? "video" as const : "image" as const,
      mime: path.includes(".mp4") ? "video/mp4" : "image/png",
      size: png.length, modified_ms: 1, sha256: pngSha,
      expires_ms: Date.now() + 60_000, chunk_bytes: MEDIA_CHUNK_BYTES,
      max_bytes: 10 * 1024 * 1024, max_pixels: 16_777_216, width: path.includes(".mp4") ? 0 : 1,
      height: path.includes(".mp4") ? 0 : 1,
    }),
    workspaceMediaRead: async () => ({ handle, offset: 0, length: png.length, bytes: png, eof: true }),
    workspaceMediaClose: async () => ({ handle, closed: true as const }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: null, ahead: 0, behind: 0, truncated: false, revision, changes: [],
    }),
    gitDiff: async () => ({
      path: "src/app.ts", layer: "worktree" as const, patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1,
      binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({ items: [], truncated: false, revision }),
  } as unknown as LiveSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function boot(live: LiveSession = liveFixture()): Promise<void> {
  act(() => {
    // Capture the pre-existing daemon-scoped maps BEFORE seeding: applySnapshot
    // prunes pane pins/preferences/completion state, and restore() must return
    // the prior canonical maps + raw storage to keep foreign fixtures intact.
    testSnapshotRestorer.capture();
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    resetPaneView();
    attachLiveSession(live);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/work/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }],
    });
  });
  await act(async () => { await enterWorkspace("p1"); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  clearWorkspacePendingReveal();
  resetWorkspaceNavigationSeam();
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

afterEach(async () => {
  closeTestDialogs();
  await act(async () => {
    clearWorkspacePendingReveal();
    enterWorkspace("");
    setScreen("home");
    setPhase("boot");
    resetPaneView();
    selectPane("");
    unmountApp();
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    resetWorkspaceNavigationSeam();
    resetTransitionState();
    await happy.happyDOM.abort();
  });
  testSnapshotRestorer.restore();
  expect(isAppMounted()).toBeFalse();
})

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((el) => (
    el.getAttribute("aria-label") === label || el.textContent?.trim().includes(label)
  ));
  if (!found) throw new Error(`missing button ${label}: ${root.innerHTML.slice(0, 400)}`);
  return found as HTMLButtonElement;
}

function clickHeld(label: string): void {
  act(() => buttonNamed(label).click());
}

/** Resolve once the published media view satisfies the predicate (real publication
 * boundary; no fixed delay). Truly bounded: a remaining-time timer rejects if no
 * publication arrives, and both the timer and subscription are cleaned up on
 * success and on timeout. */
async function waitForMedia(predicate: (m: ReturnType<typeof getWorkspaceSnapshot>["media"]) => boolean, what = "media"): Promise<void> {
  if (predicate(getWorkspaceSnapshot().media)) return;
  const total = 5000;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      if (ok) resolve();
      else reject(new Error(`timed out waiting for media ${what}: ${JSON.stringify(getWorkspaceSnapshot().media)}`));
    };
    const check = (): void => {
      if (predicate(getWorkspaceSnapshot().media)) finish(true);
    };
    const unsubscribe = subscribeWorkspace(check);
    timer = setTimeout(() => finish(false), total);
    check();
  });
}


describe("workspace media preview (actual feature App page)", () => {
  test("images auto-load and videos wait for an explicit load", async () => {
    const live = liveFixture();
    let opens = 0;
    live.workspaceMediaOpen = async (_pane, path) => { opens++; return liveFixture().workspaceMediaOpen(_pane, path); };
    await boot(live);
    await act(async () => {
      await loadWorkspaceFile("src/cat.png");
      await waitForMedia((m) => m.status === "ready", "image ready");
    });
    const snap = getWorkspaceSnapshot();
    expect(snap.media.role).toBe("image");
    expect(snap.media.status).toBe("ready");
    expect(snap.media.url).not.toBe("");
    expect(root.querySelector(".workspace-media-image")).toBeTruthy();
    expect(opens).toBe(1);

    await act(async () => { await loadWorkspaceFile("src/clip.mp4"); });
    const snap2 = getWorkspaceSnapshot();
    expect(snap2.media.role).toBe("video");
    expect(snap2.media.status).toBe("idle");
    expect(opens).toBe(1); // video stays idle until the explicit load action
    expect(root.textContent).toContain("加载视频");
  });

  test("unknown_op is an update-daemon state, not a generic unsupported guess", async () => {
    const live = liveFixture();
    live.workspaceMediaOpen = async () => { throw new ProtocolError("unknown_op", "WorkspaceMediaOpen"); };
    await boot(live);
    await act(async () => {
      await loadWorkspaceFile("src/cat.png");
      await loadWorkspaceMedia("src/cat.png");
    });
    expect(getWorkspaceSnapshot().media.status).toBe("error");
    expect(getWorkspaceSnapshot().media.error).toContain("升级 pairfob");
  });

  test("a forbidden error does not claim an update-daemon hint", async () => {
    const live = liveFixture();
    live.workspaceMediaOpen = async () => { throw new ProtocolError("forbidden", "nope"); };
    await boot(live);
    await act(async () => {
      await loadWorkspaceFile("src/cat.png");
      await loadWorkspaceMedia("src/cat.png");
    });
    expect(getWorkspaceSnapshot().media.status).toBe("error");
    expect(getWorkspaceSnapshot().media.error).not.toContain("升级 pairfob");
  });

  test("rapid file switches keep the later selection with the first Open held", async () => {
    const live = liveFixture();
    let slowOpens = 0;
    const entered = deferred<void>();
    const resolveSlow = deferred<Awaited<ReturnType<typeof live.workspaceMediaOpen>>>();
    live.workspaceMediaOpen = async (_pane, path) => {
      if (path.endsWith("cat.png")) {
        slowOpens++;
        entered.resolve();
        return resolveSlow.promise;
      }
      return liveFixture().workspaceMediaOpen(_pane, path);
    };
    await boot(live);
    // Drive the first (image) selection until its autoload has really entered the
    // held Open — an observed producer boundary, not a fixed sleep.
    await act(async () => {
      await loadWorkspaceFile("src/cat.png");
      await entered.promise;
    });
    expect(slowOpens).toBe(1);
    // Now switch to the video selection while the first Open is still held.
    await act(async () => {
      const second = loadWorkspaceFile("src/clip.mp4");
      resolveSlow.resolve(await liveFixture().workspaceMediaOpen("p1", "src/cat.png"));
      await second;
    });
    const snap = getWorkspaceSnapshot();
    expect(snap.detailPath).toBe("src/clip.mp4");
    expect(snap.media.role).toBe("video");
  });

  test("back from a file restores the directory list; detailPath retained; media retired", async () => {
    await boot();
    await act(async () => {
      await loadWorkspaceFile("src/cat.png");
      await waitForMedia((m) => m.status === "ready", "image ready");
    });
    expect(root.querySelector(".workspace-shell")?.classList.contains("detail")).toBeTrue();
    expect(getWorkspaceSnapshot().media.path).toBe("src/cat.png");
    clickHeld("返回列表");
    const snap = getWorkspaceSnapshot();
    expect(snap.view).toBe("browser");
    expect(snap.detailPath).toBe("src/cat.png");
    expect(snap.media.path).toBe("");
  });

  test("media then text renders the text preview", async () => {
    await boot();
    await act(async () => { await loadWorkspaceFile("src/clip.mp4"); });
    expect(root.querySelector(".workspace-media-prompt")).toBeTruthy();
    await act(async () => { await loadWorkspaceFile("src/app.ts"); });
    const snap = getWorkspaceSnapshot();
    expect(snap.detailPath).toBe("src/app.ts");
    expect(snap.media.role).toBe("text");
    expect(root.querySelector(".workspace-code")?.textContent).toContain("export const ready");
    expect(root.querySelector(".workspace-media-prompt")).toBeNull();
  });

  test("load action renders progress before the read finishes", async () => {
    const live = liveFixture();
    let resolveRead!: (value: Awaited<ReturnType<typeof live.workspaceMediaRead>>) => void;
    live.workspaceMediaRead = () => new Promise((resolve) => { resolveRead = resolve; });
    await boot(live);
    await act(async () => { await loadWorkspaceFile("src/clip.mp4"); });
    let pending: Promise<boolean>;
    await act(async () => { pending = loadWorkspaceMedia("src/clip.mp4"); });
    expect(root.querySelector(".workspace-media-prompt")).toBeNull();
    expect(getWorkspaceSnapshot().media.status).toBe("loading");
    expect(root.querySelector(".workspace-media-progress")).not.toBeNull();
    await act(async () => {
      resolveRead({ handle, offset: 0, length: png.length, bytes: png, eof: true });
      await pending!;
    });
  });

  test("an old actual player error during a newer publication cannot replace it", async () => {
    const store = await import("./store.ts");
    await boot();
    await act(async () => { await loadWorkspaceFile("src/clip.mp4"); await loadWorkspaceMedia("src/clip.mp4"); });
    const old = root.querySelector("video");
    expect(old).not.toBeNull();
    const current = getWorkspaceSnapshot().media;
    const newer = { ...current, path: "src/new.mp4", url: "blob:new-review", status: "ready" as const };
    let fired = 0;
    // Dispatch the OLD node's error while the newer media identity is being
    // published (the old node callback is still valid during this publication).
    const stop = store.subscribeWorkspace(() => {
      if (getWorkspaceSnapshot().media.path === newer.path && !fired) {
        fired++;
        old!.dispatchEvent(new happy.Event("error") as unknown as Event);
      }
    });
    try {
      act(() => { store.issueTicket({ content: "keep" })!.commit({ media: newer }); });
    } finally {
      stop();
    }
    const actual = getWorkspaceSnapshot().media;
    expect(fired).toBe(1);
    expect(actual.path).toBe(newer.path);
    expect(actual.url).toBe(newer.url);
    expect(actual.status).toBe("ready");
  });

  test("SVG text download fetches the FULL file (not the truncated preview source)", async () => {
    const fullBytes = new TextEncoder().encode("<svg><title>full download</title></svg>");
    const fullSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", fullBytes))]
      .map((value) => value.toString(16).padStart(2, "0")).join("");
    // Truncated preview source read for the SVG text, but the media download must
    // fetch the WHOLE file through Open/Read.
    let opens = 0;
    let readsBytes = 0;
    const live = liveFixture();
    live.workspaceRead = async (_pane, path) => ({
      path, kind: "text" as const, size: fullBytes.length, modified_ms: 1,
      content: "<svg><title>full", // truncated
      truncated: true, revision,
    });
    live.workspaceMediaOpen = async (_pane, path) => {
      opens++;
      return {
        handle, path, kind: "download" as const, mime: "image/svg+xml",
        size: fullBytes.length, modified_ms: 1, sha256: fullSha,
        expires_ms: Date.now() + 60_000, chunk_bytes: MEDIA_CHUNK_BYTES,
        max_bytes: 32 * 1024 * 1024, max_pixels: 16_777_216, width: 0, height: 0,
      };
    };
    live.workspaceMediaRead = async () => {
      readsBytes = fullBytes.length;
      return { handle, offset: 0, length: fullBytes.length, bytes: fullBytes, eof: true };
    };
    await boot(live);
    await act(async () => { await loadWorkspaceFile("src/mark.svg"); });
    // Source shows the truncated SVG text; a download hint is offered.
    expect(root.querySelector(".workspace-code")?.textContent).toContain("<svg>");
    expect(root.querySelector(".workspace-media-svg")).not.toBeNull();
    expect(opens).toBe(0); // no full fetch until the explicit download
    // Click the explicit download: it must go through the media loader and fetch
    // the WHOLE file, not the truncated preview.
    await act(async () => {
      clickHeld("下载");
      await waitForMedia((m) => m.status === "ready" && m.url !== "", "svg full download");
    });
    expect(opens).toBe(1);
    expect(readsBytes).toBe(fullBytes.length);
    expect(getWorkspaceSnapshot().media.size).toBe(fullBytes.length);
    const link = root.querySelector("a[download]");
    expect(link?.getAttribute("href")?.startsWith("blob:")).toBeTrue();
  });

  test("codec failure keeps a download link and the exact ready URL", async () => {
    await boot();
    await act(async () => { await loadWorkspaceFile("src/clip.mp4"); });
    await act(async () => { await loadWorkspaceMedia("src/clip.mp4"); });
    const ready = getWorkspaceSnapshot().media;
    expect(ready.status).toBe("ready");
    const readyURL = ready.url;
    act(() => { markMediaCodecFailure(mediaPlayerIdentity()); });
    const after = getWorkspaceSnapshot().media;
    expect(after.status).toBe("codec");
    expect(after.url).toBe(readyURL);
    expect(root.querySelector("a[download]")).not.toBeNull();
  });
});