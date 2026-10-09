import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle, visibleNotice } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { clearWorkspacePendingReveal, enterWorkspace, leaveWorkspace, workspaceModel } from "./index";
import { closeWorkspaceInspector, expandWorkspaceInspector, toggleWorkspaceInspector } from "./inspector";

/**
 * Files and changes are one thing on two surfaces: the inspector beside the
 * session and the workspace screen. Which one the files button opens follows
 * the window's width, so these hold the two to the same answers: the tab a
 * first look opens on, where back leads, and how a send is confirmed.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";
const realScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");

function liveFixture() {
  return {
    isConnected: () => true,
    paneRead: async () => ({ text: "", hash: "h" }),
    workspaceOpen: async (pane: string) => ({
      name: `repo-${pane}`,
      root: `/work/${pane}`,
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: `repo-${pane}`, branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_pane: string, path = "") => ({
      path,
      entries: [{ name: "app.ts", path: "app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    }),
    workspaceRead: async (_pane: string, path: string) => ({
      path, kind: "text" as const, size: 25, modified_ms: 1, content: "export const ready = true;\n", truncated: false, revision,
    }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "app.ts", original_path: null, index: " ", worktree: "M" }],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: PATCH, additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({
      items: [{ name: "main", kind: "local" as const, current: true, head: "1234567890", upstream: null }],
      truncated: false, revision,
    }),
    promptAgent: async () => ({ operation_id: "op-1" }),
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

/** A session with two panes, the first one open, in a window `width` wide. */
async function boot(width: number, height = 900): Promise<void> {
  happy.happyDOM.setWindowSize({ width, height });
  await act(async () => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    setAgentChat(false);
    setFullTerminal(false);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: ["p1", "p2"].map((pane_id) => ({
        pane_id, workspace_id: "w1", tab_id: "w1:t1", cwd: `/work/${pane_id}`, agent: "codex", agent_status: "idle" as const,
      })),
    });
    attachLiveSession(liveFixture() as never);
    mountTestApp();
    commitTest();
  });
}

/** A domain change the way the app makes one: write, then commit. */
async function change(write: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await write();
    commitTest();
  });
  await settle();
}

async function resize(width: number): Promise<void> {
  await change(() => {
    happy.happyDOM.setWindowSize({ width, height: 900 });
    window.dispatchEvent(new window.Event("resize"));
  });
}

function column(): HTMLElement | null {
  return appRoot().querySelector<HTMLElement>("aside.inspector");
}

/** Something on the page, or in a dialog over it. */
function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}: ${appRoot().innerHTML.slice(0, 400)}`);
  return found;
}

async function press(selector: string): Promise<void> {
  await act(async () => { find(selector).click(); });
  await settle();
}

/** The selected tab of whichever surface is on screen. */
function selectedTab(): string {
  return find("[role='tab'][aria-selected='true']").firstChild?.textContent ?? "";
}

const back = () => find<HTMLButtonElement>(".workspace-chrome .back");

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
});

afterEach(async () => {
  unmountTestApp();
  await act(async () => {
    closeWorkspaceInspector();
    if (currentScreen() === "workspace") leaveWorkspace();
    clearWorkspacePendingReveal();
    clearAllDiffNotes();
    closeTestDialogs();
    disposeNoticeLifecycle();
    attachLiveSession(null);
    setAgentChat(false);
    setFullTerminal(false);
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  appRoot().replaceChildren();
  if (realScreen) Object.defineProperty(globalThis, "screen", realScreen);
  else delete (globalThis as { screen?: unknown }).screen;
});

describe("the tab a first look opens on", () => {
  test("beside the list it is the changes, as the screen or as the inspector", async () => {
    // A tablet in portrait, or a narrow desktop window: the files button opens the screen.
    await boot(820);
    await change(() => enterWorkspace("p1"));
    expect(currentScreen()).toBe("workspace");
    expect(workspaceModel.tab).toBe("changes");
    expect(selectedTab()).toBe("更改");
    await change(() => leaveWorkspace());

    // Another pane, with the room for the column.
    await resize(1180);
    await change(() => selectPane("p2"));
    await change(() => toggleWorkspaceInspector());
    expect(workspaceModel.paneId).toBe("p2");
    expect(selectedTab()).toBe("更改");
  });

  test("a phone still opens on its files, upright or on its side", async () => {
    await boot(390, 844);
    await change(() => enterWorkspace("p1"));
    expect(workspaceModel.tab).toBe("files");
    expect(selectedTab()).toBe("文件");
    await change(() => leaveWorkspace());

    // The largest phones are as wide as a desktop page on their side, and are still phones.
    Object.defineProperty(globalThis, "screen", { value: { width: 932, height: 430 }, configurable: true });
    await resize(932);
    await change(() => selectPane("p2"));
    await change(() => enterWorkspace("p2"));
    expect(workspaceModel.paneId).toBe("p2");
    expect(workspaceModel.tab).toBe("files");
  });

  test("the tab the reader chose goes with the pane from the screen to the inspector and back", async () => {
    await boot(820);
    await change(() => enterWorkspace("p1"));
    await press(".workspace-tabs [role='tab']:not([aria-selected='true'])");
    expect(workspaceModel.tab).toBe("files");
    await change(() => leaveWorkspace());

    // Rotated: the column, on the tab they left.
    await resize(1180);
    await change(() => toggleWorkspaceInspector());
    expect(column()).not.toBeNull();
    expect(selectedTab()).toBe("文件");
    await press(".inspector-tab:not(.on)");
    expect(selectedTab()).toBe("更改");

    // And back: the column parks, the files button opens the screen on the same tab.
    await resize(820);
    expect(column()).toBeNull();
    await change(() => enterWorkspace("p1"));
    expect(currentScreen()).toBe("workspace");
    expect(selectedTab()).toBe("更改");
  });
});

describe("back on the workspace screen", () => {
  test("with the list and the file side by side it returns to the session in one press, and the file is still open there", async () => {
    await boot(1440);
    await change(() => toggleWorkspaceInspector());
    await press("aside.inspector .workspace-change");
    expect(workspaceModel.view).toBe("diff");
    await change(() => expandWorkspaceInspector());
    expect(currentScreen()).toBe("workspace");
    expect(find(".workspace-shell .workspace-diff-view").textContent).toContain("true");

    // The list never left the screen, so there is no list to go back to.
    expect(back().getAttribute("aria-label")).toBe("返回终端");
    await press(".workspace-chrome .back");
    expect(currentScreen()).toBe("pane");
    expect(workspaceModel.view).toBe("diff");
    expect(find("aside.inspector .inspector-switch-file").textContent).toBe("app.tsM");

    // Opened again, the screen is where they left it.
    await change(() => expandWorkspaceInspector());
    expect(workspaceModel.view).toBe("diff");
    expect(find(".workspace-shell .workspace-diff-view").textContent).toContain("true");
  });

  test("one pane at a time it still steps from the file to the list, then to the session", async () => {
    for (const width of [390, 820]) {
      await boot(width, 844);
      await change(() => enterWorkspace("p1"));
      // Changes stand last on the phone and first beside the list (`tab-order`).
      await press(`.workspace-tabs [role='tab']:${width < 720 ? "last" : "first"}-child`);
      await press(".workspace-shell .workspace-change");
      expect(workspaceModel.view).toBe("diff");

      expect(back().getAttribute("aria-label")).toBe("返回列表");
      await press(".workspace-chrome .back");
      expect(currentScreen()).toBe("workspace");
      expect(workspaceModel.view).toBe("browser");
      expect(back().getAttribute("aria-label")).toBe("返回终端");
      await press(".workspace-chrome .back");
      expect(currentScreen()).toBe("pane");
      unmountTestApp();
    }
  });
});

describe("a send is confirmed once", () => {
  async function writeNote(surface: string): Promise<void> {
    await press(`${surface} .workspace-diff-line.diff-add`);
    const field = find<HTMLTextAreaElement>(surface === "aside.inspector" ? "form.diff-note-inline textarea" : "dialog.diff-note-modal textarea");
    await act(async () => {
      field.value = "why true";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
      field.form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
  }

  test("beside the session the receipt in the column is the confirmation, and the session shows no banner", async () => {
    await boot(1440);
    await change(() => toggleWorkspaceInspector());
    await press("aside.inspector .workspace-change");
    await writeNote("aside.inspector");
    await press("aside.inspector .workspace-notes-send");

    expect(find("aside.inspector .workspace-notes-bar.is-sent").textContent).toContain("1 条批注已发给 Agent");
    expect(visibleNotice()).toBeNull();
    expect(appRoot().querySelector(".main .notice")).toBeNull();
  });

  test("on the screen the banner stays with the receipt, as on the phone", async () => {
    await boot(390, 844);
    await change(() => enterWorkspace("p1"));
    await press(".workspace-tabs [role='tab']:last-child");
    await press(".workspace-shell .workspace-change");
    await writeNote(".workspace-shell");
    await press(".workspace-shell .workspace-notes-send");

    expect(find(".workspace-shell .workspace-notes-bar.is-sent").textContent).toContain("1 条批注已发给 Agent");
    expect(visibleNotice()?.text).toBe("批注已发给 Agent。");
    expect(find(".workspace-app-notice").textContent).toContain("批注已发给 Agent。");
  });
});
