import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { attachHappyDom, leaveReactScreen, renderReactScreen } from "../../../test-support/react-dom";

const happy = attachHappyDom();
const { app, state } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { setLang } = await import("../../lib/i18n");
const { enterWorkspace, leaveWorkspace, loadDirectory, loadWorkspaceFile, refreshWorkspace, workspaceModel, WORKSPACE_PENDING_DELAY_MS, clearWorkspacePendingReveal } = await import("../../workspace");
const { ProtocolError } = await import("../../lib/protocol/errors");
const { WorkspaceScreen } = await import("./workspace");

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

function paint() {
  renderReactScreen(app, <WorkspaceScreen />);
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...app.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim().includes(label));
  if (!found) throw new Error(`missing button ${label}: ${app.innerHTML.slice(0, 500)}`);
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
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.agents = [{
    paneId: "p1",
    workspaceId: "w1",
    agent: "codex",
    status: "idle",
    workspaceLabel: "pairfob",
    cwd: "/work/pairfob",
  }];
  state.operationCapabilities = {
    ...state.operationCapabilities,
    list_worktrees: true,
    create_worktree: true,
    open_worktree: true,
  };
  state.live = live as unknown as typeof state.live;
  setRenderer(() => { paint(); });
}

async function boot(live = liveFixture()): Promise<void> {
  prepare(live);
  await act(async () => { await enterWorkspace("p1"); });
}

afterEach(async () => {
  clearWorkspacePendingReveal();
  await act(() => leaveReactScreen());
  closeTestDialogs();
  state.live = null;
  state.screen = "home";
  state.paneId = "";
  state.agents = [];
  app.replaceChildren();
  setRenderer(() => {});
});

describe("React workspace screen", () => {
  test("drills into a directory and opens a file as a page", async () => {
    await boot();
    expect(state.screen).toBe("workspace");
    expect(app.querySelectorAll('[role="tab"]')).toHaveLength(2);
    await act(() => { buttonNamed("src").click(); });
    await settle();
    expect(app.querySelector(".workspace-breadcrumbs")?.textContent).toContain("src");
    await act(() => { buttonNamed("app.ts").click(); });
    await settle();
    expect(app.querySelector(".workspace-shell")?.classList.contains("detail")).toBeTrue();
    expect(app.querySelector(".workspace-code")?.textContent).toContain("ready = true");
    await act(() => { buttonNamed("返回列表").click(); });
    expect(workspaceModel.view).toBe("browser");
    expect(app.querySelector(".workspace-nav")).toBeTruthy();
  });

  test("a cold file list uses row skeletons instead of empty copy", async () => {
    type ListResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceList"]>>;
    let release!: (value: ListResult) => void;
    const held = new Promise<ListResult>((resolve) => { release = resolve; });
    const base = liveFixture();
    prepare({ ...base, workspaceList: async () => held });
    const opening = enterWorkspace("p1");
    await waitForPending();
    const pending = app.querySelector(".workspace-list-pending");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取工作区");
    expect(app.querySelectorAll(".workspace-list-skeleton-row").length).toBe(10);
    expect(app.querySelector(".workspace-empty")).toBeNull();
    expect(app.querySelector(".workspace-feedback")).toBeNull();
    expect(app.querySelector(".workspace-breadcrumbs")).toBeNull();
    expect(app.querySelector(".spinner")).toBeNull();
    release({
      path: "",
      entries: [{ name: "src", path: "src", kind: "directory", size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null,
      truncated: false,
      revision,
    });
    await act(async () => { await opening; });
    expect(app.querySelector(".workspace-list-pending")).toBeNull();
    expect(app.querySelector(".workspace-row-name")?.textContent).toBe("src");
  });

  test("a missing workspace error fills the pane without claiming the directory is empty", async () => {
    prepare({
      ...liveFixture(),
      workspaceOpen: async () => {
        throw new ProtocolError("workspace_not_found", "gone");
      },
    });
    await act(async () => { await enterWorkspace("p1"); });
    expect(app.querySelector(".workspace-feedback-pane.workspace-error")?.textContent).toContain("已经不在了");
    expect(app.querySelector(".workspace-empty")).toBeNull();
    expect(app.querySelector(".workspace-breadcrumbs")).toBeNull();
    expect(app.querySelector(".workspace-list")).toBeNull();
  });

  test("keeps staged and working-tree diffs distinct and restores group collapse", async () => {
    await boot();
    await act(() => { buttonNamed("更改").click(); });
    await settle();
    expect(app.querySelectorAll(".workspace-change-group-title")).toHaveLength(2);
    expect(app.querySelectorAll(".workspace-change")).toHaveLength(2);
    expect(app.querySelectorAll(".workspace-change-mark")[0]?.textContent).toBe("M");
    await act(() => { buttonNamed("已暂存的更改").click(); });
    expect(app.querySelectorAll(".workspace-change")).toHaveLength(1);
    expect(buttonNamed("已暂存的更改").getAttribute("aria-expanded")).toBe("false");
    await act(() => { buttonNamed("已暂存的更改").click(); });
    await act(() => { buttonNamed("src/app.ts · 已暂存 · 修改").click(); });
    await settle();
    expect(app.querySelector(".workspace-layer-label")?.textContent).toBe("已暂存");
    expect(app.querySelectorAll(".workspace-diff-line")).toHaveLength(3);
    expect(app.querySelector(".diff-add")?.textContent).toContain("true");
  });

  test("back from the root returns to the same terminal pane", async () => {
    await boot();
    await act(() => { buttonNamed("返回终端").click(); });
    await settle();
    expect(state.screen).toBe("pane");
    expect(state.paneId).toBe("p1");
  });

  test("file preview occupies the code pane while the read is in flight", async () => {
    await boot();
    type FileResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceRead"]>>;
    let release!: (value: FileResult) => void;
    const held = new Promise<FileResult>((resolve) => { release = resolve; });
    state.live!.workspaceRead = async () => held;
    const load = loadWorkspaceFile("src/app.ts");
    expect(app.querySelector(".workspace-file-pending")).toBeNull();
    await waitForPending();
    const pending = app.querySelector(".workspace-file-pending");
    expect(pending).toBeTruthy();
    expect(pending?.getAttribute("role")).toBe("status");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取文件");
    expect(pending?.querySelector(".spinner")).toBeNull();
    expect(app.querySelector(".workspace-detail-name")?.textContent).toBe("src/app.ts");
    expect(app.querySelector(".workspace-detail-head .workspace-row-meta")?.classList.contains("is-pending")).toBeTrue();
    expect(app.querySelectorAll(".workspace-file-skeleton-line").length).toBe(48);
    expect(app.querySelector(".workspace-code")).toBeNull();
    release({ path: "src/app.ts", kind: "text", size: 4, modified_ms: 1, content: "ok\n", truncated: false, revision });
    await act(async () => { await load; });
    expect(app.querySelector(".workspace-file-pending")).toBeNull();
    expect(app.querySelector(".workspace-code")?.textContent).toBe("ok\n");
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
    expect(app.querySelector(".workspace-code")?.textContent).toContain("ready = true");
  });
});

void happy;
void leaveWorkspace;
void refreshWorkspace;
void loadDirectory;
