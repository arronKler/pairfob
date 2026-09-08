import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { attachHappyDom, leaveReactScreen, renderReactScreen } from "../../../test-support/react-dom";

const happy = attachHappyDom();
const { app, state } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { setLang } = await import("../../lib/i18n");
const { enterWorkspace, loadGitDiff, clearWorkspacePendingReveal } = await import("../../workspace");
const { sendDiffNotesToAgent } = await import("../../live-operations");
const { clearAllDiffNotes, diffNoteSendOpen, diffNotesFor } = await import("../../lib/diff-notes");
const { WorkspaceScreen } = await import("./workspace");

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

function paint() {
  renderReactScreen(app, <WorkspaceScreen />);
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function boot(live: ReturnType<typeof liveFixture>, options: { prompt_agent: boolean; hasAgent: boolean }): Promise<void> {
  setLang("zh");
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.agents = [{
    paneId: "p1", workspaceId: "w1", agent: options.hasAgent ? "codex" : "", hasAgent: options.hasAgent,
    status: "idle", workspaceLabel: "pairfob", cwd: "/work/pairfob",
  }];
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: options.prompt_agent };
  state.live = live as unknown as typeof state.live;
  setRenderer(paint);
  await act(async () => { await enterWorkspace("p1"); });
}

function rowContaining(text: string): HTMLElement {
  const row = [...app.querySelectorAll<HTMLElement>(".workspace-diff-line")].find((item) => item.textContent?.includes(text));
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
  const view = app.ownerDocument.defaultView!;
  await act(() => {
    textarea.value = body;
    textarea.dispatchEvent(new view.Event("input", { bubbles: true }));
  });
  const form = dialog.querySelector("form");
  if (!form) throw new Error("note editor has no form");
  await act(() => { form.dispatchEvent(new view.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

afterEach(async () => {
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  await act(() => leaveReactScreen());
  closeTestDialogs();
  state.live = null;
  state.screen = "home";
  state.agents = [];
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: false };
  app.replaceChildren();
  setRenderer(() => {});
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
    const view = app.ownerDocument.defaultView!;
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
    expect(app.querySelector(".workspace-diff-note")?.textContent).toContain("why false");
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
    expect(app.querySelectorAll(".workspace-diff-note")).toHaveLength(2);
    expect(rowContaining("false").classList.contains("has-note")).toBeTrue();
    const send = app.querySelector<HTMLButtonElement>(".workspace-notes-send");
    expect(send?.disabled).toBeFalse();
    await act(() => { send?.click(); });
    await settle();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("为什么是 false？");
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
    expect(app.querySelector(".workspace-notes-send")).toBeNull();
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
    await act(() => { app.querySelector<HTMLButtonElement>(".workspace-notes-send")?.click(); });
    await settle();
    expect(sent).toHaveLength(1);
    expect(diffNoteSendOpen()).toBeTrue();
    expect(app.querySelector<HTMLButtonElement>(".workspace-notes-send")?.disabled).toBeTrue();
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
    expect(app.querySelector(".workspace-notes-bar")).toBeNull();

    const live = liveFixture(async () => { throw new Error("must not send"); });
    await boot(live, { prompt_agent: true, hasAgent: false });
    await act(async () => { await loadGitDiff("src/app.ts", "worktree"); });
    await addNote(rowContaining("false"), "no agent to take this");
    expect(app.querySelector<HTMLButtonElement>(".workspace-notes-send")?.disabled).toBeTrue();
    expect(app.querySelector(".workspace-notes-hint")?.textContent).toContain("没有 Agent");
  });
});

void happy;
