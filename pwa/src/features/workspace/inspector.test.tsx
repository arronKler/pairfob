import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes, diffNoteScope, diffNotesFor, upsertDiffNote } from "../../lib/diff-notes";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { ProtocolError } from "../../lib/protocol/errors";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { composeDraft, setComposeDraft } from "../session/compose-store";
import { currentViewIncarnation } from "../session/drafts/compose-drafts";
import { isAgentChat, isFullTerminal, openPaneId, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { clearWorkspacePendingReveal, enterWorkspace, leaveWorkspace, loadGitDiff, loadWorkspaceFile, showWorkspaceTab, workspaceModel } from "./index";
import { closeWorkspaceInspector, expandWorkspaceInspector, toggleWorkspaceInspector } from "./inspector";
import { inspectorOpen } from "./inspector-store";

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";

type Fixture = { git?: boolean; promptAgent?: (input: { pane_id: string; text: string }) => Promise<unknown> };

/** Each pane has its own root, so a rebind is visible in what the column shows. */
function liveFixture({ git = true, promptAgent }: Fixture = {}) {
  return {
    isConnected: () => true,
    paneRead: async () => ({ text: "", hash: "h" }),
    workspaceOpen: async (pane: string) => ({
      name: `repo-${pane}`,
      root: `/work/${pane}`,
      features: { files: true, git_status: git, git_diff: git, git_branches: git },
      git: git ? { name: `repo-${pane}`, branch: "main", head: "1234567890", detached: false } : null,
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
      changes: [
        { path: "app.ts", original_path: null, index: " ", worktree: "M" },
        { path: "lib/very/long/path/to/workspace-picker.tsx", original_path: null, index: " ", worktree: "M" },
      ],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: PATCH, additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({
      items: [{ name: "main", kind: "local" as const, current: true, head: "1234567890", upstream: null }],
      truncated: false, revision,
    }),
    ...(promptAgent ? { promptAgent } : {}),
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

/** A desk session in guided mode with two panes, the first one open. */
async function boot(live = liveFixture()): Promise<ReturnType<typeof liveFixture>> {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
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
    attachLiveSession(live as never);
    mountTestApp();
    commitTest();
  });
  return live;
}

async function open(): Promise<void> {
  await act(async () => { toggleWorkspaceInspector(); });
  await settle();
}

/** A domain change the way the app makes one: write, then commit. */
async function change(write: () => void): Promise<void> {
  await act(async () => {
    write();
    commitTest();
  });
  await settle();
}

function column(): HTMLElement | null {
  return appRoot().querySelector<HTMLElement>("aside.inspector");
}

function inColumn<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = column()?.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector} in the inspector: ${column()?.innerHTML.slice(0, 400)}`);
  return found;
}

/** A window resize the way the app sees one: the listeners, then the commit. */
async function resize(width: number): Promise<void> {
  await act(async () => {
    happy.happyDOM.setWindowSize({ width, height: 900 });
    window.dispatchEvent(new window.Event("resize"));
    commitTest();
  });
  await settle();
}

async function click(selector: string): Promise<void> {
  await act(async () => { inColumn(selector).click(); });
  await settle();
}

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
    setComposeDraft("");
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  appRoot().replaceChildren();
  expect(inspectorOpen()).toBeFalse();
});

describe("the inspector beside the desk session", () => {
  test("opening shows the pane's changes without leaving the session", async () => {
    await boot();
    await act(async () => { setComposeDraft("half a thought"); });
    const incarnation = currentViewIncarnation();
    await open();

    expect(inspectorOpen()).toBeTrue();
    expect(appRoot().classList.contains("inspector")).toBeTrue();
    expect(column()?.getAttribute("aria-label")).toBe("文件与更改");
    // No navigation and none of the ceremony that retires the session view.
    expect(currentScreen()).toBe("pane");
    expect(currentViewIncarnation()).toBe(incarnation);
    expect(composeDraft()).toBe("half a thought");
    expect(appRoot().querySelector(".main")).not.toBeNull();
    // The session's column carries the app notice; this one does not repeat it.
    expect(column()?.querySelector(".workspace-app-notice")).toBeNull();

    expect(workspaceModel.paneId).toBe("p1");
    expect(workspaceModel.descriptor?.root).toBe("/work/p1");
    expect(workspaceModel.tab).toBe("changes");
    const tabs = [...column()!.querySelectorAll<HTMLElement>("[role='tab']")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["更改2", "文件"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(column()?.querySelectorAll(".workspace-change")).toHaveLength(2);
  });

  test("a directory outside git has files only", async () => {
    await boot(liveFixture({ git: false }));
    await open();
    expect(column()?.querySelector("[role='tablist']")).toBeNull();
    expect(inColumn(".inspector-title").textContent).toBe("文件");
    expect(workspaceModel.tab).toBe("files");
    expect(column()?.querySelectorAll(".workspace-file")).toHaveLength(1);
  });

  test("an open file or diff collapses the list into a switcher that leads back to it", async () => {
    await boot();
    await open();
    await click(".workspace-change:last-child");
    expect(workspaceModel.view).toBe("diff");
    expect(column()?.querySelector(".workspace-change")).toBeNull();
    const back = inColumn(".inspector-switch-file");
    expect(back.textContent).toBe("workspace-picker.tsxM");
    expect(back.getAttribute("title")).toBe("lib/very/long/path/to/workspace-picker.tsx");
    expect(inColumn(".inspector-switch .workspace-layer-label").textContent).toBe("工作区");
    expect(inColumn(".inspector-switch .workspace-additions").textContent).toBe("+1");
    expect(inColumn(".workspace-step-where").textContent).toContain("2 / 2");
    // The page's footer stepper moved into the switcher; the footer is for notes.
    expect(column()?.querySelector(".workspace-diff-footer .workspace-stepper")).toBeNull();
    expect(inColumn(".workspace-diff-footer .workspace-diff-hint").textContent).toContain("点一行写批注");

    await click(".workspace-step[aria-label='上一个改动文件']");
    expect(workspaceModel.detailPath).toBe("app.ts");
    await click(".inspector-switch-file");
    expect(workspaceModel.view).toBe("browser");
    expect(column()?.querySelectorAll(".workspace-change")).toHaveLength(2);

    await click("[role='tab']:last-child");
    await click(".workspace-file .workspace-row-main");
    expect(workspaceModel.view).toBe("file");
    expect(inColumn(".inspector-switch-file").textContent).toBe("app.ts");
    expect(inColumn(".workspace-code").textContent).toContain("export const ready");
    // The current tab is also a way back to its list.
    await click("[role='tab'][aria-selected='true']");
    expect(workspaceModel.view).toBe("browser");
  });

  test("closing gives the model back and leaves the session alone", async () => {
    await boot();
    await open();
    await act(async () => { await loadGitDiff("app.ts", "worktree"); });
    expect(diffNoteScope()?.paneId).toBe("p1");
    const incarnation = currentViewIncarnation();

    await click(".inspector-close");
    expect(inspectorOpen()).toBeFalse();
    expect(column()).toBeNull();
    expect(appRoot().classList.contains("inspector")).toBeFalse();
    expect(diffNoteScope()).toBeNull();
    expect(currentScreen()).toBe("pane");
    expect(openPaneId()).toBe("p1");
    expect(currentViewIncarnation()).toBe(incarnation);
    expect(isAgentChat()).toBeFalse();
    expect(isFullTerminal()).toBeFalse();
  });

  test("another pane rebinds it, and each pane keeps its own place and notes", async () => {
    const live = await boot();
    const opened = spyOn(live, "workspaceOpen");
    await open();
    await act(async () => { await loadGitDiff("app.ts", "worktree"); });
    await act(async () => {
      upsertDiffNote({ path: "app.ts", layer: "worktree", side: "new", line: 2, snippet: "true" }, "p1 note");
    });

    await change(() => selectPane("p2"));
    expect(inspectorOpen()).toBeTrue();
    expect(workspaceModel.paneId).toBe("p2");
    expect(workspaceModel.descriptor?.root).toBe("/work/p2");
    expect(workspaceModel.view).toBe("browser");
    expect(inColumn(".workspace-repo-title").textContent).toContain("repo-p2");
    expect(diffNotesFor("app.ts", "worktree")).toHaveLength(0);

    await change(() => selectPane("p1"));
    expect(workspaceModel.paneId).toBe("p1");
    expect(workspaceModel.view).toBe("diff");
    expect(workspaceModel.detailPath).toBe("app.ts");
    expect(diffNotesFor("app.ts", "worktree").map((note) => note.body)).toEqual(["p1 note"]);
    expect(opened.mock.calls.map(([pane]) => pane)).toEqual(["p1", "p2"]);
  });

  test("it closes when the selection clears, the page changes, or the computer goes", async () => {
    await boot();
    await open();
    await change(() => { selectPane(""); setScreen("home"); });
    expect(inspectorOpen()).toBeFalse();
    expect(diffNoteScope()).toBeNull();

    await change(() => { selectPane("p1"); setScreen("pane"); });
    expect(column()).toBeNull();
    await open();
    await change(() => setScreen("settings"));
    expect(inspectorOpen()).toBeFalse();

    await change(() => setScreen("pane"));
    await open();
    expect(workspaceModel.paneId).toBe("p1");
    await change(() => attachLiveSession(null));
    expect(inspectorOpen()).toBeFalse();
  });

  test("a window too narrow for the column parks it, and the room brings it back on the same diff", async () => {
    await boot();
    await open();
    await act(async () => { await loadGitDiff("app.ts", "worktree"); });
    await act(async () => {
      upsertDiffNote({ path: "app.ts", layer: "worktree", side: "new", line: 2, snippet: "true" }, "kept");
      setComposeDraft("half a thought");
    });
    const incarnation = currentViewIncarnation();

    await resize(800);
    // The choice stands; the layout has no column for it and the model is released.
    expect(inspectorOpen()).toBeTrue();
    expect(column()).toBeNull();
    expect(appRoot().classList.contains("inspector")).toBeFalse();
    expect(diffNoteScope()).toBeNull();
    expect(currentScreen()).toBe("pane");

    await resize(1440);
    expect(inspectorOpen()).toBeTrue();
    expect(diffNoteScope()?.paneId).toBe("p1");
    expect(workspaceModel.paneId).toBe("p1");
    expect(workspaceModel.tab).toBe("changes");
    expect(workspaceModel.view).toBe("diff");
    expect(workspaceModel.detailPath).toBe("app.ts");
    expect(inColumn(".inspector-switch-file").textContent).toBe("app.tsM");
    expect(inColumn(".workspace-diff-note").textContent).toContain("kept");
    // The session never noticed.
    expect(currentViewIncarnation()).toBe(incarnation);
    expect(composeDraft()).toBe("half a thought");
  });

  test("parked, the files button's page takes the model and the column follows it back", async () => {
    await boot();
    await open();
    await resize(800);
    // What the files button does below the roomy tier.
    await act(async () => { await enterWorkspace("p1"); });
    await settle();
    expect(currentScreen()).toBe("workspace");
    expect(inspectorOpen()).toBeTrue();
    await act(async () => { await loadWorkspaceFile("app.ts"); });
    await act(async () => { leaveWorkspace(); });
    await settle();
    expect(currentScreen()).toBe("pane");
    expect(column()).toBeNull();

    await resize(1440);
    expect(workspaceModel.view).toBe("file");
    expect(inColumn(".inspector-switch-file").textContent).toBe("app.ts");
  });

  test("parked, it still ends with the session: the list, another computer, or the reader closing it", async () => {
    await boot();
    await open();
    await resize(800);
    await change(() => { selectPane(""); setScreen("home"); });
    expect(inspectorOpen()).toBeFalse();
    await change(() => { selectPane("p1"); setScreen("pane"); });
    await resize(1440);
    expect(column()).toBeNull();

    await open();
    await resize(800);
    await change(() => attachLiveSession(null));
    expect(inspectorOpen()).toBeFalse();

    await change(() => attachLiveSession(liveFixture() as never));
    await resize(1440);
    expect(column()).toBeNull();
    await open();
    await click(".inspector-close");
    await resize(800);
    await resize(1440);
    expect(inspectorOpen()).toBeFalse();
    expect(column()).toBeNull();
  });

  test("it leaves chat and the complete terminal in the mode they were in", async () => {
    // No mounted app: the rule is about the session domain, not about a render.
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    for (const mode of ["chat", "terminal"] as const) {
      await act(async () => {
        setPhase("live");
        setScreen("pane");
        selectPane("p1");
        setAgentChat(mode === "chat");
        setFullTerminal(mode === "terminal");
        attachLiveSession(liveFixture() as never);
      });
      const incarnation = currentViewIncarnation();
      await open();
      expect(workspaceModel.paneId).toBe("p1");
      expect(workspaceModel.returnView).toBe(mode === "chat" ? "agent" : "full");
      await act(async () => { closeWorkspaceInspector(); });
      expect(currentScreen()).toBe("pane");
      expect(isAgentChat()).toBe(mode === "chat");
      expect(isFullTerminal()).toBe(mode === "terminal");
      expect(currentViewIncarnation()).toBe(incarnation);
    }
  });

  test("a failed read says why in the column and retries in place", async () => {
    const live = liveFixture();
    let refuse = true;
    const opened = spyOn(live, "workspaceOpen").mockImplementation(async (pane: string) => {
      if (refuse) throw new ProtocolError("unknown_op", "unknown op");
      return { name: `repo-${pane}`, root: `/work/${pane}`, features: { files: true, git_status: false, git_diff: false, git_branches: false }, git: null };
    });
    await boot(live);
    await open();
    expect(inColumn("[role='alert']").textContent).toContain("当前 daemon 还不支持工作区查看。");
    // Nothing is known about the directory yet, so the head names the column, not a tab.
    expect(inColumn(".inspector-title").textContent).toBe("文件与更改");

    refuse = false;
    await click("[role='alert'] .btn");
    expect(opened).toHaveBeenCalledTimes(2);
    expect(currentScreen()).toBe("pane");
    expect(column()?.querySelector("[role='alert']")).toBeNull();
    expect(column()?.querySelectorAll(".workspace-file")).toHaveLength(1);
  });

  test("the repository line opens branches", async () => {
    await boot();
    await open();
    const repo = inColumn<HTMLButtonElement>("button.workspace-repo-title");
    expect(repo.textContent).toContain("repo-p1");
    expect(repo.textContent).toContain("/work/p1");
    await act(async () => { repo.click(); });
    await settle();
    expect(document.querySelector("dialog.workspace-branch-sheet")?.textContent).toContain("main");
  });

  test("refresh reloads in place", async () => {
    const live = await boot();
    const opened = spyOn(live, "workspaceOpen");
    await open();
    await click("[role='tab']:last-child");
    const incarnation = currentViewIncarnation();
    await click(".inspector-head [aria-label='刷新工作区']");
    expect(opened).toHaveBeenCalledTimes(2);
    expect(currentScreen()).toBe("pane");
    expect(currentViewIncarnation()).toBe(incarnation);
    expect(workspaceModel.tab).toBe("files");
    expect(column()?.querySelectorAll(".workspace-file")).toHaveLength(1);
  });

  test("expanding opens the workspace screen on the same file, and leaving it returns beside the session", async () => {
    await boot();
    await open();
    await act(async () => { await loadWorkspaceFile("app.ts"); });
    await act(async () => { await expandWorkspaceInspector(); });
    await settle();
    expect(currentScreen()).toBe("workspace");
    expect(column()).toBeNull();
    expect(appRoot().querySelector(".workspace-shell .workspace-code")?.textContent).toContain("export const ready");

    await act(async () => { leaveWorkspace(); });
    await settle();
    expect(currentScreen()).toBe("pane");
    expect(inspectorOpen()).toBeTrue();
    expect(workspaceModel.paneId).toBe("p1");
    expect(workspaceModel.view).toBe("file");
    expect(inColumn(".inspector-switch-file").textContent).toBe("app.ts");
  });

  test("file actions and the detail menu work from the column", async () => {
    await boot();
    await open();
    await act(async () => { showWorkspaceTab("files"); });
    await act(async () => {
      inColumn(".workspace-file .workspace-row-main")
        .dispatchEvent(new happy.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();
    expect(document.querySelector("dialog.workspace-file-menu")?.textContent).toContain("复制路径");
    closeTestDialogs();

    await click(".workspace-file .workspace-row-main");
    await click(".workspace-detail-more-inline");
    const menu = document.querySelector("dialog.workspace-file-menu");
    expect(menu?.textContent).toContain("刷新工作区");
    // Nothing to leave: the session is right there and the column has its own close.
    expect(menu?.textContent).not.toContain("关闭文件与更改");
  });

  test("notes are sent to the agent from the column and the reader stays on the diff", async () => {
    const sent: Array<{ pane_id: string; text: string }> = [];
    await boot(liveFixture({ promptAgent: async (input) => { sent.push(input); return { operation_id: "op-1" }; } }));
    await open();
    await click(".workspace-change");
    await act(async () => { inColumn(".workspace-diff-line.diff-add").click(); });
    await settle();
    // Written in place: the editor is a form under the line, not a dialog over the page.
    expect(document.querySelector("dialog.diff-note-modal")).toBeNull();
    const textarea = inColumn<HTMLTextAreaElement>(".workspace-diff form.diff-note-inline textarea");
    await act(async () => {
      textarea.value = "why true";
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
      textarea.form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(inColumn(".workspace-diff-note").textContent).toContain("why true");

    await click(".workspace-notes-send");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ pane_id: "p1" });
    expect(sent[0].text).toContain("why true");
    expect(inColumn(".workspace-notes-bar.is-sent").textContent).toContain("1 条批注已发给 Agent");
    expect(column()?.querySelector(".workspace-notes-terminal")).toBeNull();
    expect(workspaceModel.view).toBe("diff");
    expect(currentScreen()).toBe("pane");
    expect(inspectorOpen()).toBeTrue();
  });
});
