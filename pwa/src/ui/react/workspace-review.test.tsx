import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";

const { app, state } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { setLang, t } = await import("../../lib/i18n");
const { ProtocolError } = await import("../../lib/protocol/errors");
const { clearAllDiffNotes, diffNotesFor } = await import("../../lib/diff-notes");
const {
  enterWorkspace, leaveWorkspace, loadDirectory, loadGitDiff, loadWorkspaceFile,
  workspaceModel, clearWorkspacePendingReveal,
} = await import("../../workspace");
const { WorkspaceScreen } = await import("./workspace");
const { leaveReactScreen, renderReactScreen } = await import("./root");

const revision = "a".repeat(64);
const patch = "@@ -1 +1 @@\n-old\n+new\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async (pane: string) => ({
      name: pane, root: `/work/${pane}`,
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: pane, branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_pane: string, path = "") => ({
      path, entries: [{ name: "app.ts", path: "app.ts", kind: "file" as const,
        size: 25, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    }),
    workspaceRead: async (_pane: string, path: string) => ({
      path, kind: "text" as const, size: 25, modified_ms: 1,
      content: "export const ready = true;\n", truncated: false, revision,
    }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0,
      truncated: false, revision, changes: [],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch, additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({
      items: [{ name: "main", kind: "local" as const, current: true, head: "1234567890", upstream: null }],
      truncated: false, revision,
    }),
  };
}

function paint() { renderReactScreen(<WorkspaceScreen />); }

async function settle() {
  await act(async () => { await new Promise<void>(done => window.setTimeout(done, 0)); });
}

async function boot(live = liveFixture()) {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.operationBusy = false;
  state.operationCapabilities = { ...state.operationCapabilities, rename_file: false, delete_file: false };
  state.agents = ["p1", "p2"].map(paneId => ({
    paneId, workspaceId: paneId, agent: "codex", status: "idle", cwd: `/work/${paneId}`,
  }));
  state.live = live as unknown as typeof state.live;
  setRenderer(paint);
  await act(async () => { await enterWorkspace("p1"); });
}

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
});

afterEach(async () => {
  setRenderer(() => {});
  leaveWorkspace();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  await act(() => leaveReactScreen());
  act(closeTestDialogs);
  state.live = null;
  state.screen = "home";
  state.operationBusy = false;
  app.replaceChildren();
});

describe("independent React workspace review", () => {
  test("binary diff shows its explanation without fabricated text rows", async () => {
    await boot();
    workspaceModel.view = "diff";
    workspaceModel.diff = { path: "logo.png", layer: "worktree", binary: true,
      patch: "Binary files a/logo.png and b/logo.png differ\n", additions: 0, deletions: 0,
      truncated: false, revision };
    await act(paint);
    expect(app.querySelector(".workspace-main .workspace-empty")?.textContent).toBe(t("workspace.binary"));
    expect(app.querySelector(".workspace-diff-line")).toBeNull();
  });

  test("switching to a cached diff resets the new file scroll", async () => {
    await boot();
    await act(async () => { await loadGitDiff("a.ts", "worktree"); });
    await act(async () => { await loadGitDiff("b.ts", "worktree"); });
    const table = app.querySelector<HTMLElement>(".workspace-diff")!;
    table.scrollTop = 240;
    table.scrollLeft = 80;
    await act(async () => { await loadGitDiff("a.ts", "worktree"); });
    const next = app.querySelector<HTMLElement>(".workspace-diff")!;
    expect(next.dataset.diffKey).toBe("a.ts:worktree");
    expect(next.scrollTop).toBe(0);
    expect(next.scrollLeft).toBe(0);
  });

  test("native close removes the branch dialog and permits reopening", async () => {
    await boot();
    await act(async () => { app.querySelector<HTMLButtonElement>(".workspace-branch")!.click(); });
    await settle();
    const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
    expect(dialog.open).toBe(true);
    await act(async () => dialog.close());
    await settle();
    expect(document.querySelector("dialog.sheet") === null).toBe(true);
    await act(async () => { app.querySelector<HTMLButtonElement>(".workspace-branch")!.click(); });
    await settle();
    expect(document.querySelector<HTMLDialogElement>("dialog.sheet")?.open).toBe(true);
  });

  test("new file action capability binds to the existing keyed file row", async () => {
    await boot();
    const row = app.querySelector<HTMLButtonElement>(".workspace-file")!;
    expect(row.getAttribute("aria-haspopup")).toBeNull();
    state.operationCapabilities = { ...state.operationCapabilities, rename_file: true };
    await act(paint);
    expect(app.querySelector(".workspace-file") === row).toBe(true);
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    await act(() => { row.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "ContextMenu", bubbles: true, cancelable: true,
    })); });
    expect(document.querySelector("dialog.sheet")?.textContent).toContain(t("fileActions.rename"));
  });

  test("late branch results from a previous pane cannot open a new pane sheet", async () => {
    const live = liveFixture();
    const held = deferred<Awaited<ReturnType<typeof live.gitBranches>>>();
    live.gitBranches = () => held.promise;
    await boot(live);
    await act(async () => { app.querySelector<HTMLButtonElement>(".workspace-branch")!.click(); });
    await act(async () => { state.paneId = "p2"; await enterWorkspace("p2"); });
    await act(async () => { held.resolve({ items: [], truncated: false, revision }); await held.promise; });
    await settle();
    expect(workspaceModel.paneId).toBe("p2");
    expect(document.querySelector("dialog.sheet") === null).toBe(true);
  });

  test("late file read cannot replace a newly selected directory", async () => {
    const live = liveFixture();
    const held = deferred<Awaited<ReturnType<typeof live.workspaceRead>>>();
    live.workspaceRead = () => held.promise;
    await boot(live);
    let loading!: Promise<void>;
    await act(() => { loading = loadWorkspaceFile("app.ts"); });
    await act(async () => { await loadDirectory("other"); });
    await act(async () => {
      held.resolve({ path: "app.ts", kind: "text", size: 1, modified_ms: 1, content: "stale", truncated: false, revision });
      await loading;
    });
    expect(workspaceModel.directory).toBe("other");
    expect(workspaceModel.view).toBe("browser");
    expect(app.querySelector(".workspace-code") === null).toBe(true);
  });

  test("file delete confirmation retains the original workspace scope", async () => {
    const live = liveFixture();
    const calls: unknown[][] = [];
    await boot(Object.assign(live, {
      workspaceDelete: async (...args: unknown[]) => { calls.push(args); },
    }));
    state.operationCapabilities = { ...state.operationCapabilities, delete_file: true };
    // Mount after enabling capability to exercise the established binding.
    await act(() => leaveReactScreen());
    await act(paint);
    await act(() => { app.querySelector(".workspace-file")!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const choose = () => [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
      .find(button => button.textContent === t("fileActions.delete"))!;
    await act(async () => { choose().click(); });
    await settle();
    await act(async () => { state.paneId = "p2"; await enterWorkspace("p2"); });
    await act(async () => { choose().click(); });
    await settle();
    expect(calls).toHaveLength(0);
    expect(workspaceModel.paneId).toBe("p2");
  });

  test("uncertain deletion refreshes once and does not replay through React", async () => {
    const live = liveFixture();
    const list = live.workspaceList;
    let reads = 0;
    let deletes = 0;
    live.workspaceList = async (...args) => { reads++; return list(...args); };
    await boot(Object.assign(live, {
      workspaceDelete: async () => { deletes++; throw new ProtocolError("unknown_outcome", "uncertain"); },
    }));
    state.operationCapabilities = { ...state.operationCapabilities, delete_file: true };
    await act(() => leaveReactScreen());
    await act(paint);
    await act(() => { app.querySelector(".workspace-file")!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const choose = () => [...document.querySelectorAll<HTMLButtonElement>("dialog button")]
      .find(button => button.textContent === t("fileActions.delete"))!;
    await act(async () => { choose().click(); });
    await settle();
    await act(async () => { choose().click(); });
    await settle();
    expect(deletes).toBe(1);
    expect(reads).toBe(2);
    expect(workspaceModel.error).toContain("不要立即重试");
    expect(state.operationBusy).toBe(false);
  });

  test("note draft, focus, selection and one editor survive unrelated repaint", async () => {
    await boot();
    await act(async () => { await loadGitDiff("app.ts", "worktree"); });
    await act(() => { app.querySelector<HTMLButtonElement>(".diff-comment-btn")!.click(); });
    const field = document.querySelector<HTMLTextAreaElement>(".diff-note-modal textarea")!;
    field.value = "保留输入中的批注";
    field.setSelectionRange(2, 5);
    field.focus();
    await act(paint);
    expect(document.querySelectorAll(".diff-note-modal")).toHaveLength(1);
    expect(document.querySelector(".diff-note-modal textarea") === field).toBe(true);
    expect(field.value).toBe("保留输入中的批注");
    expect(document.activeElement === field).toBe(true);
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 5]);
    await act(() => { field.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(diffNotesFor("app.ts", "worktree")[0]?.body).toBe("保留输入中的批注");
  });
});
