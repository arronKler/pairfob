import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { mountTestApp, commitTest, unmountTestApp } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { setPhase } from "../connection/connection-store";
import { setScreen } from "../../app/navigation-store";
import { selectPane } from "../session/session-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { setLang } from "../../lib/i18n";
import { enterWorkspace, leaveWorkspace, clearWorkspacePendingReveal } from "./index";

const seedRestorer = new WorkspaceSnapshotRestorer();
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
    workspaceList: async () => ({ path: "", entries: [], next_cursor: null, truncated: false, revision }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0, truncated: false, revision, changes: [],
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
      worktrees: [{
        path: "/work/pairfob-workspace-inspector",
        branch: "feat/workspace-inspector-mobile",
        label: "Workspace inspector",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: "w1",
      }],
    }),
  };
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...appRoot().querySelectorAll("button"), ...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim().includes(label));
  if (!found) throw new Error(`missing button ${label}`);
  return found as HTMLButtonElement;
}

async function settle(update?: () => void): Promise<void> {
  await act(async () => {
    update?.();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

async function boot(): Promise<void> {
  await act(async () => {
    setLang("zh");
    seedRestorer.capture();
    setPhase("live");
    setScreen("workspace");
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
    attachLiveSession(liveFixture() as never);
    mountTestApp();
    commitTest();
    await enterWorkspace("p1");
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
});

afterEach(async () => {
  unmountTestApp();
  await act(async () => {
    leaveWorkspace();
    clearWorkspacePendingReveal();
    clearAllDiffNotes();
    closeTestDialogs();
    disposeNoticeLifecycle();
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  appRoot().replaceChildren();
});

describe("React workspace branches", () => {
  test("shows branches read-only and routes changes through worktrees", async () => {
    await boot();
    await settle(() => buttonNamed("分支与 Worktree").click());
    const dialog = document.querySelector("dialog.sheet");
    expect(dialog?.textContent).toContain("feature/mobile");
    expect(dialog?.textContent).toContain("新建 Worktree");
    expect(dialog?.textContent).not.toContain("删除分支");
    expect(dialog?.textContent).not.toContain("强制切换");
  });

  test("lists worktrees as complete tappable cards after the branch sheet action", async () => {
    await boot();
    await settle(() => buttonNamed("分支与 Worktree").click());
    const listAction = [...document.querySelectorAll("dialog.sheet button")]
      .find((item) => item.textContent?.trim() === "Worktree 列表") as HTMLButtonElement | undefined;
    expect(listAction).toBeTruthy();
    await settle(() => listAction?.click());
    await settle();
    const dialog = document.querySelector("dialog.operation-modal");
    const card = dialog?.querySelector<HTMLButtonElement>(".worktree-card");
    expect(dialog?.querySelector(".modal-title")?.textContent).toBe("Worktree 列表");
    expect(card?.textContent).toContain("Workspace inspector");
    expect(card?.textContent).toContain("feat/workspace-inspector-mobile");
    expect(card?.getAttribute("aria-label")).toBe("打开 Workspace inspector");
  });
});