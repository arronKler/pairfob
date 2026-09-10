import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { setPhase } from "../connection/connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { openPaneId, selectPane } from "../session/session-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { attachLiveSession, liveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { ProtocolError } from "../../lib/protocol/errors";
import { setLang } from "../../lib/i18n";
import { WorkspaceScreen } from "../../pages/workspace/screen";
import {
  enterWorkspace,
  loadWorkspaceFile,
  refreshWorkspace,
  workspaceModel,
  WORKSPACE_PENDING_DELAY_MS,
  clearWorkspacePendingReveal,
} from "./index";

const revision = "a".repeat(64);

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async () => ({
      name: "pairfob",
      root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: "pairfob", branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_paneId: string, path = "") => ({
      path,
      entries: path
        ? [{ name: "app.ts", path: "src/app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }]
        : [{ name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null,
      truncated: false,
      revision,
    }),
    workspaceRead: async () => ({
      path: "src/app.ts", kind: "text" as const, size: 25, modified_ms: 1,
      content: "export const ready = true;\n", truncated: false, revision,
    }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 1, behind: 0, truncated: false, revision,
      changes: [{ path: "src/app.ts", original_path: null, index: "M", worktree: "M" }],
    }),
    gitDiff: async (_paneId: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: "@@ -1 +1 @@\n-false\n+true\n", additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({
      items: [
        { name: "main", kind: "local" as const, current: true, head: "1234567890", upstream: "origin/main" },
        { name: "feature/mobile", kind: "local" as const, current: false, head: "abcdef", upstream: null },
      ],
      truncated: false,
      revision,
    }),
  };
}

const seedRestorer = new WorkspaceSnapshotRestorer();

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...appRoot().querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim().includes(label));
  if (!found) throw new Error(`missing button ${label}: ${appRoot().innerHTML.slice(0, 500)}`);
  return found as HTMLButtonElement;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function waitForPending(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, WORKSPACE_PENDING_DELAY_MS + 20)); });
}

function prepare(live = liveFixture()): void {
  setLang("zh");
  seedRestorer.capture();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  applyCapabilities({
    ...NO_OPERATION_CAPABILITIES,
    list_worktrees: true,
    create_worktree: true,
    open_worktree: true,
  }, []);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "pairfob" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: "idle" }],
  });
  attachLiveSession(live as never);
}

/** Mount the real WorkspaceScreen once; store publishes drive its async updates. */
function mountPage(): void {
  renderReact(<WorkspaceScreen />);
}

async function boot(live = liveFixture()): Promise<void> {
  prepare(live);
  mountPage();
  await act(async () => { await enterWorkspace("p1"); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
});

afterEach(async () => {
  await act(async () => { unmountReact(); });
  clearWorkspacePendingReveal();
  await act(async () => { closeTestDialogs(); await Promise.resolve(); });
  await act(async () => {
    seedRestorer.restore();
    attachLiveSession(null);
    setScreen("home");
    // Original teardown cleared the open pane id explicitly; it must not leak
    // into the next case (the workspace store restorer does not clear session).
    selectPane("");
  });
});

describe("React workspace screen", () => {
  test("drills into a directory and opens a file as a page", async () => {
    await boot();
    expect(currentScreen()).toBe("workspace");
    expect(appRoot().querySelectorAll('[role="tab"]')).toHaveLength(2);
    await act(() => { buttonNamed("src").click(); });
    await settle();
    expect(appRoot().querySelector(".workspace-breadcrumbs")?.textContent).toContain("src");
    await act(() => { buttonNamed("app.ts").click(); });
    await settle();
    expect(appRoot().querySelector(".workspace-shell")?.classList.contains("detail")).toBeTrue();
    expect(appRoot().querySelector(".workspace-code")?.textContent).toContain("ready = true");
    await act(() => { buttonNamed("返回列表").click(); });
    expect(workspaceModel.view).toBe("browser");
    expect(appRoot().querySelector(".workspace-nav")).toBeTruthy();
  });

  test("a cold file list uses row skeletons instead of empty copy", async () => {
    type ListResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceList"]>>;
    let release!: (value: ListResult) => void;
    const held = new Promise<ListResult>((resolve) => { release = resolve; });
    const base = liveFixture();
    prepare({ ...base, workspaceList: async () => held });
    mountPage();
    const opening = enterWorkspace("p1");
    await waitForPending();
    const pending = appRoot().querySelector(".workspace-list-pending");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取工作区");
    expect(appRoot().querySelectorAll(".workspace-list-skeleton-row").length).toBe(10);
    expect(appRoot().querySelector(".workspace-empty")).toBeNull();
    expect(appRoot().querySelector(".workspace-feedback")).toBeNull();
    expect(appRoot().querySelector(".workspace-breadcrumbs")).toBeNull();
    expect(appRoot().querySelector(".spinner")).toBeNull();
    release({
      path: "",
      entries: [{ name: "src", path: "src", kind: "directory", size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null,
      truncated: false,
      revision,
    });
    await act(async () => { await opening; });
    expect(appRoot().querySelector(".workspace-list-pending")).toBeNull();
    expect(appRoot().querySelector(".workspace-row-name")?.textContent).toBe("src");
  });

  test("a missing workspace error fills the pane without claiming the directory is empty", async () => {
    prepare({
      ...liveFixture(),
      workspaceOpen: async () => {
        throw new ProtocolError("workspace_not_found", "gone");
      },
    });
    mountPage();
    await act(async () => { await enterWorkspace("p1"); });
    expect(appRoot().querySelector(".workspace-feedback-pane.workspace-error")?.textContent).toContain("已经不在了");
    expect(appRoot().querySelector(".workspace-empty")).toBeNull();
    expect(appRoot().querySelector(".workspace-breadcrumbs")).toBeNull();
    expect(appRoot().querySelector(".workspace-list")).toBeNull();
  });

  test("keeps staged and working-tree diffs distinct and restores group collapse", async () => {
    await boot();
    await act(() => { buttonNamed("更改").click(); });
    await settle();
    expect(appRoot().querySelectorAll(".workspace-change-group-title")).toHaveLength(2);
    expect(appRoot().querySelectorAll(".workspace-change")).toHaveLength(2);
    expect(appRoot().querySelectorAll(".workspace-change-mark")[0]?.textContent).toBe("M");
    await act(() => { buttonNamed("已暂存的更改").click(); });
    expect(appRoot().querySelectorAll(".workspace-change")).toHaveLength(1);
    expect(buttonNamed("已暂存的更改").getAttribute("aria-expanded")).toBe("false");
    await act(() => { buttonNamed("已暂存的更改").click(); });
    await act(() => { buttonNamed("src/app.ts · 已暂存 · 修改").click(); });
    await settle();
    expect(appRoot().querySelector(".workspace-layer-label")?.textContent).toBe("已暂存");
    expect(appRoot().querySelectorAll(".workspace-diff-line")).toHaveLength(3);
    expect(appRoot().querySelector(".diff-add")?.textContent).toContain("true");
  });

  test("back from the root returns to the same terminal pane", async () => {
    await boot();
    await act(() => { buttonNamed("返回终端").click(); });
    await settle();
    expect(currentScreen()).toBe("pane");
    expect(openPaneId()).toBe("p1");
  });

  test("file preview occupies the code pane while the read is in flight", async () => {
    await boot();
    type FileResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceRead"]>>;
    let release!: (value: FileResult) => void;
    const held = new Promise<FileResult>((resolve) => { release = resolve; });
    liveSession()!.workspaceRead = async () => held;
    let load!: Promise<void>;
    act(() => { load = loadWorkspaceFile("src/app.ts"); });
    expect(appRoot().querySelector(".workspace-file-pending")).toBeNull();
    await waitForPending();
    const pending = appRoot().querySelector(".workspace-file-pending");
    expect(pending).toBeTruthy();
    expect(pending?.getAttribute("role")).toBe("status");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取文件");
    expect(pending?.querySelector(".spinner")).toBeNull();
    expect(appRoot().querySelector(".workspace-detail-name")?.textContent).toBe("src/app.ts");
    expect(appRoot().querySelector(".workspace-detail-head .workspace-row-meta")?.classList.contains("is-pending")).toBeTrue();
    expect(appRoot().querySelectorAll(".workspace-file-skeleton-line").length).toBe(48);
    expect(appRoot().querySelector(".workspace-code")).toBeNull();
    release({ path: "src/app.ts", kind: "text", size: 4, modified_ms: 1, content: "ok\n", truncated: false, revision });
    await act(async () => { await load; });
    expect(appRoot().querySelector(".workspace-file-pending")).toBeNull();
    expect(appRoot().querySelector(".workspace-code")?.textContent).toBe("ok\n");
  });

  test("refreshing a file stays on the file page", async () => {
    await boot();
    await act(() => { buttonNamed("src").click(); });
    await settle();
    await act(() => { buttonNamed("app.ts").click(); });
    await settle();
    await act(() => { buttonNamed("刷新工作区").click(); });
    await settle();
    expect(workspaceModel.view).toBe("file");
    expect(appRoot().querySelector(".workspace-code")?.textContent).toContain("ready = true");
  });
});