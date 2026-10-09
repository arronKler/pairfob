import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { clearWorkspacePendingReveal, enterWorkspace, leaveWorkspace, workspaceModel } from "./index";
import { closeWorkspaceInspector, toggleWorkspaceInspector } from "./inspector";
import { inspectorOpen } from "./inspector-store";
import { dismissFilesDialogs, ownFilesDialog } from "./surface-dialogs";

/**
 * What a files surface opened over the page leaves with it. A file's menu, the
 * question before a delete, the rename field and the branch sheet are about
 * the list they were opened from: when the column is parked by a narrow
 * window, closed, or bound to another pane, or the screen is left, none of
 * them stays behind to ask about a file that is not shown. A note in progress
 * is kept, as before.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";
let release: () => void = () => {};
/** Mutations the surface asked the computer for. */
let mutations: string[] = [];

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
    workspaceDelete: async (_pane: string, _root: string, path: string) => { mutations.push(`delete ${path}`); },
    workspaceRename: async (_pane: string, _root: string, path: string, name: string) => { mutations.push(`rename ${path} ${name}`); },
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

/** A session with two panes, the first one open, in a window `width` wide. */
async function boot(width: number): Promise<void> {
  happy.happyDOM.setWindowSize({ width, height: 900 });
  await act(async () => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    setAgentChat(false);
    setFullTerminal(false);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true, rename_file: true, delete_file: true }, []);
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

type Input = "mouse" | "touch";

/** Something on the page, or in a dialog over it. */
function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}: ${appRoot().innerHTML.slice(0, 400)}`);
  return found;
}

async function press(target: HTMLElement, input: Input = "mouse"): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: input }) as unknown as Event);
    target.click();
  });
  await settle();
}

const column = () => appRoot().querySelector<HTMLElement>("aside.inspector");
const openDialogs = () => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
const menu = () => document.querySelector<HTMLDialogElement>("dialog.workspace-file-menu[open]");
const confirm = () => document.querySelector<HTMLDialogElement>("dialog.confirm[open]");
const rename = () => document.querySelector<HTMLDialogElement>("dialog.text-edit[open]");
const branches = () => document.querySelector<HTMLDialogElement>("dialog.workspace-branch-sheet[open]");

/** A row of the open menu, by its label. */
function menuRow(label: string): HTMLElement {
  const row = [...menu()!.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.includes(label));
  if (!row) throw new Error(`no menu row ${label}: ${menu()!.textContent}`);
  return row;
}

/** The column beside the session, on its files tab. */
async function openColumnOnFiles(): Promise<void> {
  await boot(1440);
  await change(() => toggleWorkspaceInspector());
  await press([...column()!.querySelectorAll<HTMLElement>(".inspector-tab")].find((tab) => tab.textContent?.includes("文件"))!);
  expect(workspaceModel.tab).toBe("files");
}

/** The menu of the listed file, from its "more". */
async function openFileMenu(input: Input = "mouse"): Promise<void> {
  await press(find(".workspace-row-more"), input);
  expect(menu()).not.toBeNull();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
  mutations = [];
  release = bindOverlayOrigin(document);
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
  release();
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("the column parked by a narrow window takes what was opened from its list", () => {
  for (const input of ["mouse", "touch"] as const) {
    test(`a file's menu, as the ${input === "mouse" ? "popover a mouse gets" : "bottom sheet a finger gets"}`, async () => {
      await openColumnOnFiles();
      await openFileMenu(input);
      expect(menu()!.classList.contains("popover")).toBe(input === "mouse");

      await resize(800);
      expect(column()).toBeNull();
      // Parked, not closed: the reader's choice stands, and nothing of the files floats over the session.
      expect(inspectorOpen()).toBeTrue();
      expect(openDialogs()).toHaveLength(0);

      await resize(1440);
      expect(column()).not.toBeNull();
      expect(openDialogs()).toHaveLength(0);
    });
  }

  test("the question before a delete: it is put away unanswered, and nothing is deleted", async () => {
    await openColumnOnFiles();
    await openFileMenu();
    await press(menuRow(t("fileActions.delete")));
    expect(confirm()?.textContent).toContain("app.ts");

    await resize(800);
    expect(openDialogs()).toHaveLength(0);
    await settle();
    expect(mutations).toEqual([]);
    await resize(1440);
    expect(openDialogs()).toHaveLength(0);
    expect(find(".workspace-row-main").textContent).toContain("app.ts");
  });

  test("the rename field, whatever was typed in it: no file is renamed from a list that is not shown", async () => {
    await openColumnOnFiles();
    await openFileMenu();
    await press(menuRow(t("fileActions.rename")));
    const field = rename()!.querySelector("input")!;
    await act(async () => {
      field.value = "renamed.ts";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });

    await resize(800);
    expect(openDialogs()).toHaveLength(0);
    await settle();
    expect(mutations).toEqual([]);
  });

  test("the branch sheet", async () => {
    await openColumnOnFiles();
    await press(find("aside.inspector .workspace-branch"));
    expect(branches()).not.toBeNull();
    await resize(800);
    expect(openDialogs()).toHaveLength(0);
    await resize(1440);
    expect(openDialogs()).toHaveLength(0);
  });
});

describe("the other ways the list leaves the page", () => {
  test("the column closed, or bound to another pane's files, takes the menu of the last pane's file", async () => {
    await openColumnOnFiles();
    await openFileMenu();
    await change(() => selectPane("p2"));
    expect(workspaceModel.paneId).toBe("p2");
    expect(openDialogs()).toHaveLength(0);

    await press([...column()!.querySelectorAll<HTMLElement>(".inspector-tab")].find((tab) => tab.textContent?.includes("文件"))!);
    await openFileMenu();
    await press(menuRow(t("fileActions.delete")));
    expect(confirm()).not.toBeNull();
    await change(() => closeWorkspaceInspector());
    expect(openDialogs()).toHaveLength(0);
    await settle();
    expect(mutations).toEqual([]);
  });

  test("the screen left for the session from under an open question", async () => {
    await boot(800);
    await change(() => enterWorkspace("p1"));
    await press([...appRoot().querySelectorAll<HTMLElement>(".workspace-tab")].find((tab) => tab.textContent?.includes("文件"))!);
    await openFileMenu();
    await press(menuRow(t("fileActions.delete")));
    expect(confirm()).not.toBeNull();
    // Not the reader's own Back, which the question covers: the pane's session took the page.
    await change(() => leaveWorkspace());
    expect(currentScreen()).toBe("pane");
    expect(openDialogs()).toHaveLength(0);
    await settle();
    expect(mutations).toEqual([]);
  });
});

describe("what is not theirs to close", () => {
  test("on the screen a resize leaves the question where it is: its list is still shown, and its answer still deletes", async () => {
    await boot(800);
    await change(() => enterWorkspace("p1"));
    await press([...appRoot().querySelectorAll<HTMLElement>(".workspace-tab")].find((tab) => tab.textContent?.includes("文件"))!);
    await openFileMenu();
    await press(menuRow(t("fileActions.delete")));
    await resize(760);
    await resize(1024);
    expect(confirm()).not.toBeNull();
    await press([...confirm()!.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === t("fileActions.delete"))!);
    await settle();
    expect(mutations).toEqual(["delete app.ts"]);
  });

  test("only what a files surface opened is closed, and a note in progress is kept", async () => {
    await openColumnOnFiles();
    // A dialog of someone else's, open over the same page.
    const other = document.createElement("dialog");
    document.body.append(other);
    other.showModal();
    // And one opened for the files, through the same door the menu uses.
    const mine = document.createElement("dialog");
    ownFilesDialog(() => { document.body.append(mine); mine.showModal(); });
    expect(mine.hasAttribute("data-files-dialog")).toBeTrue();
    expect(other.hasAttribute("data-files-dialog")).toBeFalse();
    dismissFilesDialogs();
    expect(mine.open).toBeFalse();
    expect(mine.returnValue).toBe("cancel");
    expect(other.open).toBeTrue();
    other.close();
    other.remove();
    mine.remove();

    // The note under its line waits through the same parking that closes the menus.
    await press([...column()!.querySelectorAll<HTMLElement>(".inspector-tab")].find((tab) => tab.textContent?.includes("更改"))!);
    await press(find('aside.inspector [data-change="worktree:app.ts"]'));
    await press(find("aside.inspector .workspace-diff-line.diff-add"));
    const field = find<HTMLTextAreaElement>("aside.inspector form.diff-note-inline textarea");
    await act(async () => {
      field.value = "half written";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await resize(800);
    await resize(1440);
    expect(find<HTMLTextAreaElement>("aside.inspector form.diff-note-inline textarea").value).toBe("half written");
  });
});
