import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) globals[key] = (happy as unknown as Record<string, unknown>)[key];
globals.location = happy.location;
globals.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderWorkspace } = await import("./workspace.ts");
const { enterWorkspace, loadWorkspaceFile, workspaceModel } = await import("../workspace.ts");

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
        ? [{ name: "app.ts", path: "src/app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false }]
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
    listWorktrees: async () => ({
      worktrees: [
        {
          path: "/work/pairfob-workspace-inspector",
          branch: "feat/workspace-inspector-mobile",
          label: "Workspace inspector",
          is_bare: false,
          is_detached: false,
          is_prunable: false,
          is_linked_worktree: true,
          open_workspace_id: "w1",
        },
      ],
    }),
  };
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...app.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim().includes(label));
  if (!found) throw new Error(`missing button ${label}: ${app.innerHTML.slice(0, 500)}`);
  return found as HTMLButtonElement;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function boot(live = liveFixture()): Promise<void> {
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
  setRenderer(renderWorkspace);
  await enterWorkspace("p1");
}

afterEach(() => {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  state.live = null;
  state.screen = "home";
  state.paneId = "";
  state.agents = [];
  app.replaceChildren();
});

describe("mobile workspace navigation", () => {
  test("drills into a directory and opens a file as a page", async () => {
    await boot();
    expect(state.screen).toBe("workspace");
    expect(app.querySelectorAll('[role="tab"]')).toHaveLength(2);
    buttonNamed("src").click();
    await settle();
    expect(app.querySelector(".workspace-breadcrumbs")?.textContent).toContain("src");
    buttonNamed("app.ts").click();
    await settle();
    expect(app.querySelector(".workspace-shell")?.classList.contains("detail")).toBeTrue();
    expect(app.querySelector(".workspace-code")?.textContent).toContain("ready = true");
    buttonNamed("返回列表").click();
    expect(workspaceModel.view).toBe("browser");
    expect(app.querySelector(".workspace-nav")).toBeTruthy();
  });

  test("refreshes a file in place instead of dropping back to the tree", async () => {
    await boot();
    buttonNamed("src").click();
    await settle();
    buttonNamed("app.ts").click();
    await settle();
    buttonNamed("刷新工作区").click();
    await settle();
    expect(workspaceModel.view).toBe("file");
    expect(app.querySelector(".workspace-code")?.textContent).toContain("ready = true");
  });

  test("ignores an older file response after a faster selection", async () => {
    await boot();
    type FileResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["workspaceRead"]>>;
    let resolveSlow!: (value: FileResult) => void;
    let resolveFast!: (value: FileResult) => void;
    const slow = new Promise<FileResult>((resolve) => { resolveSlow = resolve; });
    const fast = new Promise<FileResult>((resolve) => { resolveFast = resolve; });
    state.live = {
      ...liveFixture(),
      workspaceRead: async (_paneId: string, path: string) => path === "slow.ts" ? slow : fast,
    } as unknown as typeof state.live;

    const slowLoad = loadWorkspaceFile("slow.ts");
    const fastLoad = loadWorkspaceFile("fast.ts");
    resolveFast({ path: "fast.ts", kind: "text", size: 4, modified_ms: 1, content: "fast", truncated: false, revision });
    await fastLoad;
    resolveSlow({ path: "slow.ts", kind: "text", size: 4, modified_ms: 1, content: "slow", truncated: false, revision });
    await slowLoad;

    expect(workspaceModel.detailPath).toBe("fast.ts");
    expect(workspaceModel.file?.path).toBe("fast.ts");
    expect(app.querySelector(".workspace-code")?.textContent).toBe("fast");
  });

  test("keeps staged and working-tree diffs distinct", async () => {
    await boot();
    buttonNamed("更改").click();
    await settle();
    expect(app.querySelectorAll(".workspace-change-group-title")).toHaveLength(2);
    expect(app.querySelectorAll(".workspace-change")).toHaveLength(2);
    expect(app.querySelectorAll(".workspace-change-mark")[0]?.textContent).toBe("M");

    buttonNamed("已暂存的更改").click();
    expect(app.querySelectorAll(".workspace-change")).toHaveLength(1);
    expect(buttonNamed("已暂存的更改").getAttribute("aria-expanded")).toBe("false");
    buttonNamed("已暂存的更改").click();

    buttonNamed("src/app.ts · 已暂存 · 修改").click();
    await settle();
    expect(app.querySelector(".workspace-layer-label")?.textContent).toBe("已暂存");
    expect(app.querySelectorAll(".workspace-diff-line")).toHaveLength(3);
    expect(app.querySelector(".diff-add")?.textContent).toContain("true");
  });

  test("shows branches read-only and routes changes through worktrees", async () => {
    await boot();
    buttonNamed("分支与 Worktree").click();
    await settle();
    const dialog = document.querySelector("dialog.sheet");
    expect(dialog?.textContent).toContain("feature/mobile");
    expect(dialog?.textContent).toContain("新建 Worktree");
    expect(dialog?.textContent).not.toContain("删除分支");
    expect(dialog?.textContent).not.toContain("强制切换");
  });

  test("shows each worktree as a complete tappable card", async () => {
    await boot();
    buttonNamed("分支与 Worktree").click();
    await settle();
    const listAction = [...document.querySelectorAll("dialog.sheet button")]
      .find((item) => item.textContent?.trim() === "Worktree 列表") as HTMLButtonElement | undefined;
    expect(listAction).toBeTruthy();
    listAction?.click();
    await settle();
    await settle();

    const dialog = document.querySelector("dialog.operation-modal");
    const card = dialog?.querySelector<HTMLButtonElement>(".worktree-card");
    expect(dialog?.querySelector(".modal-title")?.textContent).toBe("Worktree 列表");
    expect(card?.textContent).toContain("Workspace inspector");
    expect(card?.textContent).toContain("feat/workspace-inspector-mobile");
    expect(card?.textContent).toContain("/work/pairfob-workspace-inspector");
    expect(card?.textContent).toContain("已打开");
    expect(card?.getAttribute("aria-label")).toBe("打开 Workspace inspector");
    expect(dialog?.querySelector(".worktree-item > .btn-primary")).toBeNull();
  });

  test("keeps a collapsed change group when reopening from the same page", async () => {
    await boot();
    buttonNamed("更改").click();
    await settle();
    buttonNamed("已暂存的更改").click();
    expect(buttonNamed("已暂存的更改").getAttribute("aria-expanded")).toBe("false");

    buttonNamed("返回终端").click();
    await enterWorkspace("p1");

    expect(workspaceModel.tab).toBe("changes");
    expect(buttonNamed("已暂存的更改").getAttribute("aria-expanded")).toBe("false");
    expect(app.querySelectorAll(".workspace-change")).toHaveLength(1);
  });

  test("back from the root returns to the same terminal pane", async () => {
    await boot();
    buttonNamed("返回终端").click();
    await settle();
    expect(state.screen).toBe("pane");
    expect(state.paneId).toBe("p1");
  });

  test("dismisses and reopens the cached file without another read", async () => {
    const base = liveFixture();
    const calls = { open: 0, list: 0, read: 0, status: 0 };
    const live = {
      ...base,
      workspaceOpen: async () => {
        calls.open++;
        return base.workspaceOpen();
      },
      workspaceList: async (paneId: string, path = "") => {
        calls.list++;
        return base.workspaceList(paneId, path);
      },
      workspaceRead: async () => {
        calls.read++;
        return base.workspaceRead();
      },
      gitStatus: async () => {
        calls.status++;
        return base.gitStatus();
      },
    };
    await boot(live);
    buttonNamed("src").click();
    await settle();
    buttonNamed("app.ts").click();
    await settle();
    expect(calls).toEqual({ open: 1, list: 2, read: 1, status: 1 });

    buttonNamed("关闭工作区查看").click();
    expect(state.screen).toBe("pane");
    expect(workspaceModel.view).toBe("file");
    await enterWorkspace("p1");

    expect(state.screen).toBe("workspace");
    expect(workspaceModel.view).toBe("file");
    expect(app.querySelector(".workspace-code")?.textContent).toContain("ready = true");
    expect(calls).toEqual({ open: 1, list: 2, read: 1, status: 1 });

    buttonNamed("刷新工作区").click();
    await settle();
    expect(calls).toEqual({ open: 1, list: 2, read: 2, status: 2 });
  });
});
