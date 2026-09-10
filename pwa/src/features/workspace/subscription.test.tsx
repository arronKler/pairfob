import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../lib/protocol/client";
import { ProtocolError } from "../../lib/protocol/errors";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { mountTestApp, commitTest, unmountTestApp, appMounted } from "../../../test-support/react-harness";
import { appHost, type AppHost } from "../../app/host";
import { appRoot } from "../../app/dom-root";
import { resetTransitionState } from "../../app/transition";
import { setLang } from "../../lib/i18n";
import { setPhase } from "../connection/connection-store";
import { setScreen, currentScreen } from "../../app/navigation-store";
import { selectPane, openPaneId, resetPaneView } from "../session/session-store";
import { attachLiveSession } from "../computers/catalog-store";
import { applySnapshot } from "../dashboard/catalog-store";
import {
  enterWorkspace, leaveWorkspace, loadWorkspaceFile, subscribeWorkspace,
  closeWorkspaceDetail, getWorkspaceSnapshot,
  WORKSPACE_PENDING_DELAY_MS, clearWorkspacePendingReveal,
} from "./index";
import { resetWorkspaceNavigationSeam } from "./navigation";

const root = appRoot();

const revision = "a".repeat(64);

/**
 * Captures and restores the dashboard/preferences preimage each case seeds:
 * the workspace seed projects completion attention and prunes pane pins and
 * prefs, so a foreign consumer's acknowledgement/pins/choices must survive.
 * Captured before the seed, restored after the assertions (approved pattern
 * shared by the other Workspace fixtures).
 */
const seedRestorer = new WorkspaceSnapshotRestorer();

/** Actual installed-host commit/requestCommit spies (pure call-through). */
let committed = 0;
let requested = 0;
let hostRef: AppHost | null = null;
let realCommit: AppHost["commit"] | null = null;
let realRequestCommit: AppHost["requestCommit"] | null = null;

function watchHostCommits(): void {
  hostRef = appHost();
  committed = 0;
  requested = 0;
  realCommit = hostRef!.commit;
  realRequestCommit = hostRef!.requestCommit;
  const commitSelf = realCommit!;
  hostRef!.commit = function (this: AppHost, options) { committed += 1; return commitSelf.apply(this, [options]); };
  const requestSelf = realRequestCommit!;
  hostRef!.requestCommit = function (this: AppHost) { requested += 1; return requestSelf.apply(this); };
}

function restoreHostCommits(): void {
  if (!hostRef) return;
  if (realCommit) hostRef.commit = realCommit;
  if (realRequestCommit) hostRef.requestCommit = realRequestCommit;
  hostRef = null;
  realCommit = null;
  realRequestCommit = null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

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
      next_cursor: null,
      truncated: false,
      revision,
    }),
    workspaceRead: async (_pane: string, path: string) => ({
      path, kind: "text" as const, size: 4, modified_ms: 1, content: `${path} body\n`, truncated: false, revision,
    }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: null, ahead: 0, behind: 0, truncated: false, revision, changes: [],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: "@@ -1 +1 @@\n-old\n+new\n", additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({ items: [], truncated: false, revision }),
  } as unknown as LiveSession;
}

function seed(live: LiveSession): void {
  seedRestorer.capture();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  resetPaneView();
  attachLiveSession(live);
  applySnapshot({
    workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/work/pairfob" }],
    panes: [
      { pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" },
      { pane_id: "p2", workspace_id: "w1", agent: "codex", agent_status: "idle" },
    ],
  });
}

function prepare(live: LiveSession = liveFixture()): void {
  act(() => {
    setLang("zh");
    seed(live);
  });
}

async function boot(live: LiveSession = liveFixture()): Promise<void> {
  prepare(live);
  await act(async () => {
    mountTestApp();
    commitTest();
    await enterWorkspace("p1");
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  clearWorkspacePendingReveal();
  resetWorkspaceNavigationSeam();
});

afterEach(async () => {
  await act(async () => {
    leaveWorkspace();
    clearWorkspacePendingReveal();
    closeTestDialogs();
    attachLiveSession(null);
  });
  unmountTestApp();
  await act(async () => {
    // Restore the pre-test selected-pane baseline (screen home, pane empty)
    // before the snapshot restorer completes, inside this act.
    setScreen("home");
    selectPane("");
    resetWorkspaceNavigationSeam();
    resetTransitionState();
    seedRestorer.restore();
    await happy.happyDOM.abort();
  });
  root.replaceChildren();
  expect(appHost()).toBeNull();
  expect(appMounted()).toBeFalse();
});

describe("workspace store subscriptions", () => {
  test("a mounted workspace paints async file data through its store subscription, no App commit", async () => {
    const live = liveFixture();
    await boot(live);
    expect(appMounted()).toBeTrue();
    expect(root.querySelector(".workspace-shell")).toBeTruthy();
    const owner = appHost();
    expect(owner).not.toBeNull();
    watchHostCommits();
    try {
      type FileResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceRead"]>>;
      const held = deferred<FileResult>();
      // The live session handle is owned by the computers domain; replace its read.
      live.workspaceRead = async () => held.promise;
      let loading!: ReturnType<typeof loadWorkspaceFile>;
      await act(() => { loading = loadWorkspaceFile("src/app.ts"); });
      await act(async () => { await new Promise<void>(done => window.setTimeout(done, WORKSPACE_PENDING_DELAY_MS + 20)); });
      expect(root.querySelector(".workspace-file-pending")).toBeTruthy();
      // A workspace store reveal must arrive by subscription alone: neither a
      // host.commit nor a host.requestCommit fires while the deferred read is
      // pending, the mounted App host stays the same, and the DOM is unchanged.
      expect(appHost()).toBe(owner);
      expect(committed).toBe(0);
      expect(requested).toBe(0);

      held.resolve({ path: "src/app.ts", kind: "text", size: 4, modified_ms: 1, content: "from-store\n", truncated: false, revision });
      await act(async () => { await loading; });
      // The content appears from the workspace subscription alone — no
      // host.commit/requestCommit around the resolved read, host still mounted.
      expect(root.querySelector(".workspace-code")?.textContent).toBe("from-store\n");
      expect(getWorkspaceSnapshot().file?.content).toBe("from-store\n");
      expect(appHost()).toBe(owner);
      expect(committed).toBe(0);
      expect(requested).toBe(0);
      expect(appMounted()).toBeTrue();
    } finally {
      restoreHostCommits();
    }
  });

  test("subscribeWorkspace notifies on commit and can unsubscribe", async () => {
    await boot();
    const seen: string[] = [];
    const stop = subscribeWorkspace(() => { seen.push(getWorkspaceSnapshot().detailPath); });
    await act(async () => { await loadWorkspaceFile("a.ts"); });
    expect(seen.some(path => path === "a.ts")).toBeTrue();
    const count = seen.length;
    stop();
    await act(async () => { await loadWorkspaceFile("b.ts"); });
    expect(seen).toHaveLength(count);
  });
});

describe("file icons and selected row (actual App)", () => {
  test("file rows show a per-type glyph icon and the open file marks its row active", async () => {
    const live = liveFixture();
    // A directory and two files with distinct extensions.
    live.workspaceList = async () => ({
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false },
        { name: "app.ts", path: "app.ts", kind: "file" as const, size: 4, modified_ms: 1, hidden: false },
        { name: "package.json", path: "package.json", kind: "file" as const, size: 2, modified_ms: 1, hidden: false },
      ],
      next_cursor: null,
      truncated: false,
      revision,
    });
    await boot(live);
    // The directory row gets a folder glyph; each file gets its own glyph.
    const rows = () => [...root.querySelectorAll<HTMLElement>(".workspace-row")];
    const glyphAt = (row: HTMLElement) => row.querySelector<HTMLElement>(".file-icon")?.getAttribute("data-file-icon");
    expect(glyphAt(rows()[0]!)).toBe("folder");
    expect(glyphAt(rows()[1]!)).toBe("ts");
    expect(glyphAt(rows()[2]!)).toBe("npm");
    // Opening a file marks its row active from snapshot.detailPath.
    await act(async () => { await loadWorkspaceFile("app.ts"); });
    expect(rows()[1]!.classList.contains("active")).toBeTrue();
    expect(rows()[0]!.classList.contains("active")).toBeFalse();
    // Closing the detail view keeps the selected path active (row stays marked);
    // the selection is retired naturally by a scope change, not by clearing it.
    await act(async () => { closeWorkspaceDetail(); });
    expect(rows()[1]!.classList.contains("active")).toBeTrue();
  });
});

describe("workspace screen behavior (actual App)", () => {
  const root2 = appRoot();
  function buttonNamed(label: string): HTMLButtonElement {
    const found = [...root2.querySelectorAll("button")].find((item) =>
      item.getAttribute("aria-label") === label || item.textContent?.trim().includes(label));
    if (!found) throw new Error(`missing button ${label}: ${root2.innerHTML.slice(0, 400)}`);
    return found as HTMLButtonElement;
  }
  const settle = () => act(async () => { await new Promise<void>(done => window.setTimeout(done, 0)); });
  const waitForPending = () => act(async () => { await new Promise<void>(done => window.setTimeout(done, WORKSPACE_PENDING_DELAY_MS + 20)); });

  test("drills into a directory and opens a file as a page", async () => {
    const live = liveFixture();
    live.workspaceList = async (_paneId: string, path = "") => ({
      path,
      entries: path
        ? [{ name: "app.ts", path: "src/app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }]
        : [{ name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null, truncated: false, revision,
    });
    live.workspaceRead = async () => ({
      path: "src/app.ts", kind: "text" as const, size: 25, modified_ms: 1,
      content: "export const ready = true;\n", truncated: false, revision,
    });
    await boot(live);
    expect(currentScreen()).toBe("workspace");
    expect(root2.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(root2.querySelector('.workspace-row [data-file-icon="folder"]')).toBeTruthy();
    await act(() => { buttonNamed("src").click(); });
    await settle();
    expect(root2.querySelector(".workspace-breadcrumbs")?.textContent).toContain("src");
    expect(root2.querySelector('.workspace-row [data-file-icon="ts"]')).toBeTruthy();
    await act(() => { buttonNamed("app.ts").click(); });
    await settle();
    expect(root2.querySelector(".workspace-shell")?.classList.contains("detail")).toBeTrue();
    expect(root2.querySelector('.workspace-detail-head [data-file-icon="ts"]')).toBeTruthy();
    expect(root2.querySelector(".workspace-code")?.textContent).toContain("ready = true");
    await act(() => { buttonNamed("返回列表").click(); });
    expect(getWorkspaceSnapshot().view).toBe("browser");
    expect(root2.querySelector(".workspace-nav")).toBeTruthy();
  });

  test("a cold file list uses row skeletons instead of empty copy", async () => {
    type ListResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceList"]>>;
    let release!: (value: ListResult) => void;
    const held = new Promise<ListResult>((resolve) => { release = resolve; });
    const base = liveFixture();
    const live: LiveSession = { ...(base as object), workspaceList: async () => held } as LiveSession;
    // Original window: seed synchronously (prepare) and start the enter as a
    // pending promise inside one act, so the workspace publish is act-wrapped
    // and no async act is left open while the cold skeleton waits below.
    prepare(live);
    let opening!: Promise<void>;
    act(() => {
      mountTestApp();
      commitTest();
      opening = enterWorkspace("p1");
    });
    await waitForPending();
    const pending = root2.querySelector(".workspace-list-pending");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取工作区");
    expect(root2.querySelectorAll(".workspace-list-skeleton-row").length).toBe(10);
    expect(root2.querySelector(".workspace-empty")).toBeNull();
    expect(root2.querySelector(".workspace-feedback")).toBeNull();
    expect(root2.querySelector(".workspace-breadcrumbs")).toBeNull();
    expect(root2.querySelector(".spinner")).toBeNull();
    await act(async () => {
      release({
        path: "",
        entries: [{ name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }],
        next_cursor: null, truncated: false, revision,
      });
      await opening;
    });
    expect(root2.querySelector(".workspace-list-pending")).toBeNull();
    expect(root2.querySelector(".workspace-row-name")?.textContent).toBe("src");
  });

  test("a missing workspace error fills the pane without claiming the directory is empty", async () => {
    const base = liveFixture();
    const live: LiveSession = {
      ...(base as object),
      workspaceOpen: async () => { throw new ProtocolError("workspace_not_found", "gone"); },
    } as LiveSession;
    await boot(live);
    expect(root2.querySelector(".workspace-feedback-pane.workspace-error")?.textContent).toContain("已经不在了");
    expect(root2.querySelector(".workspace-empty")).toBeNull();
    expect(root2.querySelector(".workspace-breadcrumbs")).toBeNull();
    expect(root2.querySelector(".workspace-list")).toBeNull();
  });

  test("keeps staged and working-tree diffs distinct and restores group collapse", async () => {
    const live = liveFixture();
    live.gitStatus = async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main" as string | null,
      ahead: 1, behind: 0, truncated: false, revision,
      changes: [{ path: "src/app.ts", original_path: null as string | null, index: "M" as const, worktree: "M" as const }],
    });
    await boot(live);
    await act(() => { buttonNamed("更改").click(); });
    await settle();
    expect(root2.querySelectorAll(".workspace-change-group-title").length).toBe(2);
    expect(root2.querySelectorAll(".workspace-change")).toHaveLength(2);
    expect(root2.querySelectorAll(".workspace-change-mark")[0]?.textContent).toBe("M");
    await act(() => { buttonNamed("已暂存的更改").click(); });
    expect(root2.querySelectorAll(".workspace-change")).toHaveLength(1);
    expect(buttonNamed("已暂存的更改").getAttribute("aria-expanded")).toBe("false");
    await act(() => { buttonNamed("已暂存的更改").click(); });
    await act(() => { buttonNamed("src/app.ts · 已暂存 · 修改").click(); });
    await settle();
    expect(root2.querySelector(".workspace-layer-label")?.textContent).toBe("已暂存");
    expect(root2.querySelectorAll(".workspace-diff-line")).toHaveLength(3);
    // The base live diff patch is "-old\n+new".
    expect(root2.querySelector(".diff-add")?.textContent).toContain("new");
  });

  test("back from the root returns to the same terminal pane", async () => {
    await boot();
    await act(() => { buttonNamed("返回终端").click(); });
    await settle();
    expect(currentScreen()).toBe("pane");
    expect(openPaneId()).toBe("p1");
  });

  test("file preview occupies the code pane while the read is in flight", async () => {
    const live = liveFixture();
    await boot(live);
    type FileResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceRead"]>>;
    let release!: (value: FileResult) => void;
    const held = new Promise<FileResult>((resolve) => { release = resolve; });
    live.workspaceRead = async () => held;
    // Starting the read publishes the file view (re-render) inside act; the
    // held promise is awaited later, so the pending skeleton renders cleanly.
    let load!: ReturnType<typeof loadWorkspaceFile>;
    act(() => { load = loadWorkspaceFile("src/app.ts"); });
    expect(root2.querySelector(".workspace-file-pending")).toBeNull();
    await waitForPending();
    const pending = root2.querySelector(".workspace-file-pending");
    expect(pending).toBeTruthy();
    expect(pending?.getAttribute("role")).toBe("status");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取文件");
    expect(pending?.querySelector(".spinner")).toBeNull();
    expect(root2.querySelector(".workspace-detail-name")?.textContent).toBe("src/app.ts");
    // The detail-head meta carries the pending marker while the read is in flight.
    expect(root2.querySelector(".workspace-detail-head .workspace-row-meta")?.classList.contains("is-pending")).toBeTrue();
    expect(root2.querySelectorAll(".workspace-file-skeleton-line").length).toBe(48);
    expect(root2.querySelector(".workspace-code")).toBeNull();
    await act(async () => {
      release({ path: "src/app.ts", kind: "text", size: 4, modified_ms: 1, content: "ok\n", truncated: false, revision });
      await load;
    });
    expect(root2.querySelector(".workspace-file-pending")).toBeNull();
    expect(root2.querySelector(".workspace-code")?.textContent).toBe("ok\n");
  });

  test("refreshing a file stays on the file page", async () => {
    const live = liveFixture();
    live.workspaceList = async (_paneId: string, path = "") => ({
      path,
      entries: path
        ? [{ name: "app.ts", path: "src/app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }]
        : [{ name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null, truncated: false, revision,
    });
    live.workspaceRead = async () => ({
      path: "src/app.ts", kind: "text" as const, size: 25, modified_ms: 1,
      content: "export const ready = true;\n", truncated: false, revision,
    });
    await boot(live);
    await act(() => { buttonNamed("src").click(); });
    await settle();
    await act(() => { buttonNamed("app.ts").click(); });
    await settle();
    await act(() => { buttonNamed("刷新工作区").click(); });
    await settle();
    expect(getWorkspaceSnapshot().view).toBe("file");
    expect(root2.querySelector(".workspace-code")?.textContent).toContain("ready = true");
  });
});