import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { attachHappyDom, leaveReactScreen, renderReactScreen } from "../../../test-support/react-dom";

const happy = attachHappyDom();
const { app, state } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { setLang } = await import("../../lib/i18n");
const { enterWorkspace, loadGitDiff, workspaceModel, WORKSPACE_PENDING_DELAY_MS, clearWorkspacePendingReveal } = await import("../../workspace");
const { clearAllDiffNotes, upsertDiffNote } = await import("../../lib/diff-notes");
const { WorkspaceScreen } = await import("./workspace");

const revision = "a".repeat(64);
const RICH_PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";

function liveFixture(truncated = false) {
  return {
    isConnected: () => true,
    workspaceOpen: async () => ({
      name: "pairfob",
      root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: "pairfob", branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async () => ({ path: "", entries: [], next_cursor: null, truncated: false, revision }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "src/app.ts", original_path: null, index: "M", worktree: "M" }],
    }),
    gitDiff: async (_paneId: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: RICH_PATCH, additions: 1, deletions: 1, binary: false, truncated, revision,
    }),
    gitBranches: async () => ({ items: [], truncated: false, revision }),
  };
}

function paint() {
  renderReactScreen(app, <WorkspaceScreen />);
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function waitForPending(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, WORKSPACE_PENDING_DELAY_MS + 20)); });
}

async function boot(live = liveFixture()): Promise<void> {
  setLang("zh");
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.agents = [{ paneId: "p1", workspaceId: "w1", agent: "codex", status: "idle", workspaceLabel: "pairfob", cwd: "/work/pairfob" }];
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: true };
  state.live = live as unknown as typeof state.live;
  setRenderer(paint);
  await act(async () => { await enterWorkspace("p1"); });
}

afterEach(async () => {
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  await act(() => leaveReactScreen());
  closeTestDialogs();
  state.live = null;
  state.screen = "home";
  state.agents = [];
  app.replaceChildren();
  setRenderer(() => {});
});

describe("React workspace diff", () => {
  test("diff preview uses a diff-shaped skeleton instead of workspace copy", async () => {
    await boot();
    type DiffResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["gitDiff"]>>;
    let release!: (value: DiffResult) => void;
    const held = new Promise<DiffResult>((resolve) => { release = resolve; });
    state.live!.gitDiff = async () => held;
    const load = loadGitDiff("src/app.ts", "worktree");
    await waitForPending();
    const pending = app.querySelector(".workspace-diff-pending");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取差异");
    expect(app.querySelectorAll(".workspace-diff-skeleton-line").length).toBe(28);
    expect(app.querySelector(".workspace-diff-skeleton-line.diff-add")).toBeTruthy();
    expect(app.querySelector(".workspace-diff-skeleton-line.diff-delete")).toBeTruthy();
    expect(app.querySelector(".workspace-feedback")).toBeNull();
    expect(app.querySelector(".workspace-detail-head .workspace-additions")?.classList.contains("is-pending")).toBeTrue();
    release({
      path: "src/app.ts", layer: "worktree", patch: "@@ -1 +1 @@\n-false\n+true\n",
      additions: 1, deletions: 1, binary: false, truncated: false, revision,
    });
    await act(async () => { await load; });
    expect(app.querySelector(".workspace-diff-pending")).toBeNull();
    expect(app.querySelector(".workspace-diff-line")).toBeTruthy();
  });

  test("does not annotate truncated diffs", async () => {
    await boot(liveFixture(true));
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    expect(app.querySelectorAll(".diff-noteable")).toHaveLength(0);
    expect(app.querySelector(".workspace-diff-hint")).toBeNull();
    expect(app.querySelector(".workspace-limit")?.textContent).toContain("不能批注");
  });

  test("shows a tap hint until a note exists and restores scroll for the same diff key", async () => {
    await boot();
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    expect(app.querySelector(".workspace-diff-hint")?.textContent).toContain("点一行写批注");
    expect(app.querySelectorAll(".diff-comment-btn")).toHaveLength(4);
    const table = app.querySelector<HTMLElement>(".workspace-diff")!;
    table.scrollTop = 24;
    table.scrollLeft = 8;
    await act(() => { paint(); });
    expect(app.querySelector<HTMLElement>(".workspace-diff")?.scrollTop).toBe(24);
    expect(app.querySelector<HTMLElement>(".workspace-diff")?.scrollLeft).toBe(8);
    upsertDiffNote({ path: "src/app.ts", layer: "worktree", side: "old", line: 2, snippet: "false" }, "keep");
    await act(() => { paint(); });
    expect(app.querySelector(".workspace-diff-hint")).toBeNull();
    expect(app.querySelector(".workspace-diff-note")?.textContent).toContain("keep");
    await act(async () => { await loadGitDiff("src/app.ts", "staged"); });
    expect(app.querySelector<HTMLElement>(".workspace-diff")?.dataset.diffKey).toBe("src/app.ts:staged");
    expect(app.querySelector<HTMLElement>(".workspace-diff")?.scrollTop).toBe(0);
  });
});

void happy;
void workspaceModel;
void settle;
