import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { mountTestApp, commitTest, unmountTestApp } from "../../../test-support/react-harness";
import { appHost, type AppHost } from "../../app/host";
import { appRoot } from "../../app/dom-root";
import { setPhase } from "../connection/connection-store";
import { setScreen } from "../../app/navigation-store";
import { selectPane } from "../session/session-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { attachLiveSession, liveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { setLang } from "../../lib/i18n";
import { bumpWorkspaceNotes, enterWorkspace, leaveWorkspace, loadGitDiff, WORKSPACE_PENDING_DELAY_MS, clearWorkspacePendingReveal } from "./index";
import { clearAllDiffNotes, upsertDiffNote } from "../../lib/diff-notes";

const seedRestorer = new WorkspaceSnapshotRestorer();
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
  hostRef!.commit = (options) => {
    committed += 1;
    realCommit!(options);
  };
  hostRef!.requestCommit = () => {
    requested += 1;
    realRequestCommit!();
  };
}

function restoreHostCommits(): void {
  if (!hostRef) return;
  if (realCommit) hostRef.commit = realCommit;
  if (realRequestCommit) hostRef.requestCommit = realRequestCommit;
  hostRef = null;
  realCommit = null;
  realRequestCommit = null;
}

async function waitForPending(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, WORKSPACE_PENDING_DELAY_MS + 20)); });
}

async function boot(live = liveFixture()): Promise<void> {
  await act(async () => {
    setLang("zh");
    seedRestorer.capture();
    setPhase("live");
    setScreen("workspace");
    selectPane("p1");
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: "idle" }],
    });
    attachLiveSession(live as never);
    mountTestApp();
    commitTest();
    await enterWorkspace("p1");
  });
  watchHostCommits();
}


beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
});

afterEach(async () => {
  await act(async () => {
    leaveWorkspace();
    clearWorkspacePendingReveal();
    clearAllDiffNotes();
    closeTestDialogs();
    disposeNoticeLifecycle();
    attachLiveSession(null);
  });
  restoreHostCommits();
  unmountTestApp();
  await act(async () => {
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  appRoot().replaceChildren();
});

describe("React workspace diff", () => {
  test("diff preview uses a diff-shaped skeleton instead of workspace copy", async () => {
    await boot();
    type DiffResult = Awaited<ReturnType<ReturnType<typeof liveFixture>["gitDiff"]>>;
    let release!: (value: DiffResult) => void;
    const held = new Promise<DiffResult>((resolve) => { release = resolve; });
    liveSession()!.gitDiff = async () => held;
    let load!: Promise<void>;
    act(() => { load = loadGitDiff("src/app.ts", "worktree"); });
    await waitForPending();
    const pending = appRoot().querySelector(".workspace-diff-pending");
    expect(pending?.getAttribute("aria-label")).toContain("正在读取差异");
    expect(appRoot().querySelectorAll(".workspace-diff-skeleton-line").length).toBe(28);
    expect(appRoot().querySelector(".workspace-diff-skeleton-line.diff-add")).toBeTruthy();
    expect(appRoot().querySelector(".workspace-diff-skeleton-line.diff-delete")).toBeTruthy();
    expect(appRoot().querySelector(".workspace-feedback")).toBeNull();
    expect(appRoot().querySelector(".workspace-detail-head .workspace-additions")?.classList.contains("is-pending")).toBeTrue();
    release({
      path: "src/app.ts", layer: "worktree", patch: "@@ -1 +1 @@\n-false\n+true\n",
      additions: 1, deletions: 1, binary: false, truncated: false, revision,
    });
    await act(async () => { await load; });
    expect(appRoot().querySelector(".workspace-diff-pending")).toBeNull();
    expect(appRoot().querySelector(".workspace-diff-line")).toBeTruthy();
  });

  test("does not annotate truncated diffs", async () => {
    await boot(liveFixture(true));
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    expect(appRoot().querySelectorAll(".diff-noteable")).toHaveLength(0);
    expect(appRoot().querySelector(".workspace-diff-hint")).toBeNull();
    expect(appRoot().querySelector(".workspace-limit")?.textContent).toContain("不能批注");
  });

  test("shows a tap hint until a note exists and restores scroll for the same diff key", async () => {
    await boot();
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    expect(appRoot().querySelector(".workspace-diff-hint")?.textContent).toContain("点一行写批注");
    expect(appRoot().querySelectorAll(".diff-comment-btn")).toHaveLength(4);
    const table = appRoot().querySelector<HTMLElement>(".workspace-diff")!;
    table.scrollTop = 24;
    table.scrollLeft = 8;
    await act(async () => { commitTest(); });
    expect(appRoot().querySelector<HTMLElement>(".workspace-diff")?.scrollTop).toBe(24);
    expect(appRoot().querySelector<HTMLElement>(".workspace-diff")?.scrollLeft).toBe(8);
    upsertDiffNote({ path: "src/app.ts", layer: "worktree", side: "old", line: 2, snippet: "false" }, "keep");
    await act(async () => { commitTest(); });
    expect(appRoot().querySelector(".workspace-diff-hint")).toBeNull();
    expect(appRoot().querySelector(".workspace-diff-note")?.textContent).toContain("keep");
    await act(async () => { await loadGitDiff("src/app.ts", "staged"); });
    expect(appRoot().querySelector<HTMLElement>(".workspace-diff")?.dataset.diffKey).toBe("src/app.ts:staged");
    expect(appRoot().querySelector<HTMLElement>(".workspace-diff")?.scrollTop).toBe(0);
  });

  test("a notes-only store update keeps the same-key scroller without a global remount", async () => {
    await boot();
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    const table = appRoot().querySelector<HTMLElement>(".workspace-diff")!;
    table.scrollTop = 22;
    table.scrollLeft = 4;
    table.dispatchEvent(new window.Event("scroll"));
    upsertDiffNote({ path: "src/app.ts", layer: "worktree", side: "new", line: 2, snippet: "true" }, "keep");
    committed = 0;
    requested = 0;
    await act(() => { bumpWorkspaceNotes(); });
    const next = appRoot().querySelector<HTMLElement>(".workspace-diff");
    expect(next?.dataset.diffKey).toBe("src/app.ts:worktree");
    expect(next?.scrollTop).toBe(22);
    expect(next?.scrollLeft).toBe(4);
    expect(appRoot().querySelector(".workspace-diff-note")?.textContent).toContain("keep");
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });
});