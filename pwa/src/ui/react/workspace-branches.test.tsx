import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "./root";

beforeEach(resetBoardTestDOM);
const { app, state } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { setLang } = await import("../../lib/i18n");
const { enterWorkspace, clearWorkspacePendingReveal } = await import("../../workspace");
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

function paint() {
  act(() => renderReactScreen(<WorkspaceScreen />));
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...app.querySelectorAll("button"), ...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim().includes(label));
  if (!found) throw new Error(`missing button ${label}`);
  return found as HTMLButtonElement;
}

async function settle(update?: () => void): Promise<void> {
  await act(async () => {
    update?.();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  clearWorkspacePendingReveal();
  await act(() => leaveReactScreen());
  await act(async () => { closeTestDialogs(); await Promise.resolve(); });
  state.live = null;
  state.screen = "home";
  state.agents = [];
  app.replaceChildren();
  setRenderer(() => {});
});

describe("React workspace branches", () => {
  test("shows branches read-only and routes changes through worktrees", async () => {
    setLang("zh");
    state.phase = "live";
    state.screen = "pane";
    state.paneId = "p1";
    state.agents = [{ paneId: "p1", workspaceId: "w1", agent: "codex", status: "idle", workspaceLabel: "pairfob", cwd: "/work/pairfob" }];
    state.operationCapabilities = {
      ...state.operationCapabilities,
      list_worktrees: true,
      create_worktree: true,
      open_worktree: true,
    };
    state.live = liveFixture() as unknown as typeof state.live;
    setRenderer(paint);
    await act(async () => { await enterWorkspace("p1"); });
    await settle(() => buttonNamed("分支与 Worktree").click());
    const dialog = document.querySelector("dialog.sheet");
    expect(dialog?.textContent).toContain("feature/mobile");
    expect(dialog?.textContent).toContain("新建 Worktree");
    expect(dialog?.textContent).not.toContain("删除分支");
    expect(dialog?.textContent).not.toContain("强制切换");
  });

  test("lists worktrees as complete tappable cards after the branch sheet action", async () => {
    setLang("zh");
    state.phase = "live";
    state.screen = "pane";
    state.paneId = "p1";
    state.agents = [{ paneId: "p1", workspaceId: "w1", agent: "codex", status: "idle", workspaceLabel: "pairfob", cwd: "/work/pairfob" }];
    state.operationCapabilities = {
      ...state.operationCapabilities,
      list_worktrees: true,
      create_worktree: true,
      open_worktree: true,
    };
    state.live = liveFixture() as unknown as typeof state.live;
    setRenderer(paint);
    await act(async () => { await enterWorkspace("p1"); });
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

void app;
