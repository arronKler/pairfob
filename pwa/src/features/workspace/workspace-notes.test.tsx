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
import { setLang } from "../../lib/i18n";
import { enterWorkspace, leaveWorkspace, loadGitDiff, refreshWorkspace, clearWorkspacePendingReveal } from "./index";
import { sendDiffNotesToAgent } from "../operations/controller";
import { adoptDiffNoteScope, clearAllDiffNotes, diffNoteScope, diffNoteSendOpen, diffNotesFor } from "../../lib/diff-notes";

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const RICH_PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";

function liveFixture(promptAgent?: (input: { pane_id: string; text: string }) => Promise<unknown>) {
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
      changes: [{ path: "src/app.ts", original_path: null, index: " ", worktree: "M" }],
    }),
    gitDiff: async (_paneId: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: RICH_PATCH, additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({ items: [], truncated: false, revision }),
    ...(promptAgent ? { promptAgent } : {}),
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function boot(live: ReturnType<typeof liveFixture>, options: { prompt_agent: boolean; hasAgent: boolean }): Promise<void> {
  await act(async () => {
    setLang("zh");
    setPhase("live");
    setScreen("workspace");
    selectPane("p1");
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: options.prompt_agent }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{
        pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob",
        agent: options.hasAgent ? "codex" : "", agent_status: "idle",
      }],
    });
    attachLiveSession(live as never);
    mountTestApp();
    commitTest();
    await enterWorkspace("p1");
  });
}

function rowContaining(text: string): HTMLElement {
  const row = [...appRoot().querySelectorAll<HTMLElement>(".workspace-diff-line")].find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`missing diff row containing ${text}`);
  return row;
}

async function addNote(row: HTMLElement, body: string): Promise<void> {
  await act(() => { row.click(); });
  await settle();
  const dialog = document.querySelector("dialog.diff-note-modal");
  if (!dialog) throw new Error("note editor dialog did not open");
  const textarea = dialog.querySelector("textarea");
  if (!textarea) throw new Error("note editor has no textarea");
  const view = appRoot().ownerDocument.defaultView!;
  await act(() => {
    textarea.value = body;
    textarea.dispatchEvent(new view.Event("input", { bubbles: true }));
  });
  const form = dialog.querySelector("form");
  if (!form) throw new Error("note editor has no form");
  await act(() => { form.dispatchEvent(new view.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
});

afterEach(async () => {
  // Let the mounted App's producers settle (store publishes, frames, notice
  // timers) inside act before retiring the workspace and the host.
  // Retire the App first so no mounted subscriber observes the resets' publishes.
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

describe("React diff notes", () => {
  test("rejects an empty body and submits with Ctrl+Enter", async () => {
    await boot(liveFixture(), { prompt_agent: true, hasAgent: true });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await act(() => { rowContaining("false").click(); });
    await settle();
    const dialog = document.querySelector("dialog.diff-note-modal")!;
    const form = dialog.querySelector("form")!;
    const textarea = dialog.querySelector("textarea")!;
    const view = appRoot().ownerDocument.defaultView!;
    await act(() => { form.dispatchEvent(new view.Event("submit", { bubbles: true, cancelable: true })); });
    expect(dialog.querySelector("[role='alert']")?.textContent).toContain("批注");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    await act(() => {
      textarea.value = "why false";
      textarea.dispatchEvent(new view.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
    expect(document.querySelector("dialog.diff-note-modal")).toBeNull();
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(1);
    expect(appRoot().querySelector(".workspace-diff-note")?.textContent).toContain("why false");
  });

  test("batches two line comments into one PromptAgent call and will not replay", async () => {
    const sent: Array<{ pane_id: string; text: string }> = [];
    const live = liveFixture(async (input) => {
      sent.push(input);
      return { operation_id: "op-1" };
    });
    await boot(live, { prompt_agent: true, hasAgent: true });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await addNote(rowContaining("false"), "为什么是 false？");
    await addNote(rowContaining("tail"), "给导出加注释");
    expect(appRoot().querySelectorAll(".workspace-diff-note")).toHaveLength(2);
    expect(rowContaining("false").classList.contains("has-note")).toBeTrue();
    const send = appRoot().querySelector<HTMLButtonElement>(".workspace-notes-send");
    expect(send?.disabled).toBeFalse();
    await act(async () => { send?.click(); });
    await settle();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("为什么是 false？");
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
    expect(appRoot().querySelector(".workspace-notes-send")).toBeNull();
  });

  test("a second send while the first is in flight does not unlock the batch", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sent: Array<{ pane_id: string; text: string }> = [];
    const live = liveFixture(async (input) => {
      sent.push(input);
      await held;
      return { operation_id: "op-1" };
    });
    await boot(live, { prompt_agent: true, hasAgent: true });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await addNote(rowContaining("false"), "first batch");
    await act(() => { appRoot().querySelector<HTMLButtonElement>(".workspace-notes-send")?.click(); });
    await settle();
    expect(sent).toHaveLength(1);
    expect(diffNoteSendOpen()).toBeTrue();
    expect(appRoot().querySelector<HTMLButtonElement>(".workspace-notes-send")?.disabled).toBeTrue();
    await act(async () => { await sendDiffNotesToAgent("src/app.ts", "worktree"); });
    expect(sent).toHaveLength(1);
    release();
    await settle();
    await settle();
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
  });

  test("hides send without prompt_agent and disables it without an agent", async () => {
    await boot(liveFixture(), { prompt_agent: false, hasAgent: true });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await addNote(rowContaining("false"), "invisible batch");
    expect(appRoot().querySelector(".workspace-notes-bar")).toBeNull();

    const live = liveFixture(async () => { throw new Error("must not send"); });
    await boot(live, { prompt_agent: true, hasAgent: false });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await addNote(rowContaining("false"), "no agent to take this");
    expect(appRoot().querySelector<HTMLButtonElement>(".workspace-notes-send")?.disabled).toBeTrue();
    expect(appRoot().querySelector(".workspace-notes-hint")?.textContent).toContain("没有 Agent");
  });

  test("an open editor cannot save into a newly loaded revision", async () => {
    await boot(liveFixture(), { prompt_agent: true, hasAgent: true });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    const original = diffNoteScope();
    expect(original?.revision).toBe(revision);
    await act(() => { rowContaining("false").click(); });
    await settle();
    adoptDiffNoteScope({ session: original!.session, paneId: original!.paneId, revision: "b".repeat(64) });
    const dialog = document.querySelector("dialog.diff-note-modal")!;
    const textarea = dialog.querySelector("textarea")!;
    const form = dialog.querySelector("form")!;
    const view = appRoot().ownerDocument.defaultView!;
    await act(() => {
      textarea.value = "stale revision note";
      textarea.dispatchEvent(new view.Event("input", { bubbles: true }));
      form.dispatchEvent(new view.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(document.querySelector("dialog.diff-note-modal")).toBeNull();
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
    adoptDiffNoteScope(original);
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
  });

  test("note editor cannot save an old revision target into the newly loaded revision", async () => {
    const live = liveFixture();
    await boot(live, { prompt_agent: true, hasAgent: true });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await act(() => { rowContaining("false").click(); });
    await settle();
    const field = document.querySelector<HTMLTextAreaElement>("dialog.diff-note-modal textarea")!;
    field.value = "old revision draft";
    live.gitDiff = async (_pane, path, layer) => ({
      path, layer, patch: "@@ -1 +1 @@\n-before\n+different\n",
      additions: 1, deletions: 1, binary: false, truncated: false, revision: "b".repeat(64),
    });
    await act(async () => { await refreshWorkspace(); });
    expect(diffNoteScope()?.revision).toBe("b".repeat(64));
    if (field.isConnected) {
      await act(() => {
        field.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      });
      await settle();
    }
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
    expect(document.querySelector("dialog.diff-note-modal")).toBeNull();
  });
});