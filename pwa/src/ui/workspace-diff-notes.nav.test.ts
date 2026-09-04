import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) globals[key] = (happy as unknown as Record<string, unknown>)[key];
globals.location = happy.location;
globals.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderWorkspace } = await import("./workspace.ts");
const { enterWorkspace, loadGitDiff } = await import("../workspace.ts");
const { sendDiffNotesToAgent } = await import("../live-operations.ts");
const { clearAllDiffNotes, diffNoteSendOpen, diffNotesFor } = await import("../lib/diff-notes.ts");

const revision = "a".repeat(64);
// context new1, delete old2, add new2, context new3 — distinct note pins.
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
    workspaceList: async (_paneId: string, path = "") => ({
      path,
      entries: path
        ? [{ name: "app.ts", path: "src/app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false }]
        : [{ name: "src", path: "src", kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }],
      next_cursor: null,
      truncated: false,
      revision,
    }),
    workspaceRead: async () => ({
      path: "src/app.ts", kind: "text" as const, size: 25, modified_ms: 1,
      content: "export const ready = true;\n", truncated: false, revision,
    }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 1, behind: 0, truncated: false, revision,
      changes: [{ path: "src/app.ts", original_path: null, index: "M", worktree: "M" }],
    }),
    gitDiff: async (_paneId: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: RICH_PATCH, additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({ items: [], truncated: false, revision }),
    ...(promptAgent ? { promptAgent } : {}),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function boot(
  live: ReturnType<typeof liveFixture>,
  options: { prompt_agent: boolean; hasAgent: boolean },
): Promise<void> {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.agents = [{
    paneId: "p1",
    workspaceId: "w1",
    agent: options.hasAgent ? "codex" : "",
    hasAgent: options.hasAgent,
    status: "idle",
    workspaceLabel: "pairfob",
    cwd: "/work/pairfob",
  }];
  state.operationCapabilities = {
    ...state.operationCapabilities,
    prompt_agent: options.prompt_agent,
  };
  state.live = live as unknown as typeof state.live;
  setRenderer(renderWorkspace);
  await enterWorkspace("p1");
}

async function openDiff(): Promise<void> {
  await loadGitDiff("src/app.ts", "worktree");
  await settle();
}

function rowContaining(text: string): HTMLElement {
  const row = [...app.querySelectorAll<HTMLElement>(".workspace-diff-line")].find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`missing diff row containing ${text}`);
  return row;
}

async function addNote(row: HTMLElement, body: string): Promise<void> {
  row.click();
  await settle();
  const dialog = document.querySelector("dialog.diff-note-modal");
  if (!dialog) throw new Error("note editor dialog did not open");
  const textarea = dialog.querySelector("textarea");
  if (!textarea) throw new Error("note editor has no textarea");
  textarea.value = body;
  const form = dialog.querySelector("form");
  if (!form) throw new Error("note editor has no form");
  form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

afterEach(() => {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  clearAllDiffNotes();
  state.live = null;
  state.screen = "home";
  state.paneId = "";
  state.agents = [];
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: false };
  app.replaceChildren();
});

describe("diff notes batch send", () => {
  test("batches two line comments into one PromptAgent call", async () => {
    const sent: Array<{ pane_id: string; text: string }> = [];
    const live = liveFixture(async (input) => {
      sent.push(input);
      return { operation_id: "op-1" };
    });
    await boot(live, { prompt_agent: true, hasAgent: true });
    await openDiff();

    expect(app.querySelector(".workspace-notes-send")).toBeNull();
    await addNote(rowContaining("false"), "为什么是 false？");
    await addNote(rowContaining("tail"), "给导出加注释");

    expect(app.querySelectorAll(".workspace-diff-note")).toHaveLength(2);
    expect(rowContaining("false").classList.contains("has-note")).toBeTrue();
    expect(app.querySelector(".workspace-notes-count")?.textContent).toContain("2");

    const send = app.querySelector<HTMLButtonElement>(".workspace-notes-send");
    expect(send).toBeTruthy();
    expect(send?.disabled).toBeFalse();
    send?.click();
    await settle();
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.pane_id).toBe("p1");
    expect(sent[0]?.text).toContain("src/app.ts");
    expect(sent[0]?.text).toContain("第 2 行（旧）");
    expect(sent[0]?.text).toContain("第 3 行（新）");
    expect(sent[0]?.text).toContain("为什么是 false？");
    expect(sent[0]?.text).toContain("给导出加注释");

    // Applied: notes for this path/layer are cleared and the bar is gone.
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
    expect(app.querySelector(".workspace-notes-send")).toBeNull();
  });

  test("a second send while the first is in flight does not unlock the batch", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: Array<{ pane_id: string; text: string }> = [];
    const live = liveFixture(async (input) => {
      sent.push(input);
      await held;
      return { operation_id: "op-1" };
    });
    await boot(live, { prompt_agent: true, hasAgent: true });
    await openDiff();
    await addNote(rowContaining("false"), "first batch");

    const send = app.querySelector<HTMLButtonElement>(".workspace-notes-send");
    send?.click();
    await settle();
    expect(sent).toHaveLength(1);
    expect(diffNoteSendOpen()).toBeTrue();
    expect(app.querySelector<HTMLButtonElement>(".workspace-notes-send")?.disabled).toBeTrue();
    expect(app.querySelector(".workspace-notes-send")?.textContent).toBe("正在发送批注…");

    await sendDiffNotesToAgent("src/app.ts", "worktree");
    expect(sent).toHaveLength(1);
    expect(diffNoteSendOpen()).toBeTrue();
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(1);

    release();
    await settle();
    await settle();
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(0);
  });

  test("hides the send control when prompt_agent is off", async () => {
    await boot(liveFixture(), { prompt_agent: false, hasAgent: true });
    await openDiff();
    await addNote(rowContaining("false"), "invisible batch");
    expect(diffNotesFor("src/app.ts", "worktree")).toHaveLength(1);
    expect(app.querySelector(".workspace-notes-send")).toBeNull();
    expect(app.querySelector(".workspace-notes-bar")).toBeNull();
  });

  test("disables send and explains when the selected pane has no agent", async () => {
    const live = liveFixture(async () => {
      throw new Error("must not send");
    });
    await boot(live, { prompt_agent: true, hasAgent: false });
    await openDiff();
    await addNote(rowContaining("false"), "no agent to take this");
    const send = app.querySelector<HTMLButtonElement>(".workspace-notes-send");
    expect(send).toBeTruthy();
    expect(send?.disabled).toBeTrue();
    expect(app.querySelector(".workspace-notes-hint")?.textContent).toContain("没有 Agent");
  });

  test("does not annotate truncated diffs", async () => {
    const live = {
      ...liveFixture(),
      gitDiff: async (_paneId: string, path: string, layer: "worktree" | "staged") => ({
        path, layer, patch: RICH_PATCH, additions: 1, deletions: 1, binary: false, truncated: true, revision,
      }),
    };
    await boot(live, { prompt_agent: true, hasAgent: true });
    await openDiff();
    expect(app.querySelectorAll(".diff-noteable")).toHaveLength(0);
    expect(app.querySelector(".workspace-diff-hint")).toBeNull();
    expect(app.querySelector(".workspace-limit")?.textContent).toContain("不能批注");
  });

  test("shows a tap hint and a comment control on each noteable line", async () => {
    await boot(liveFixture(), { prompt_agent: true, hasAgent: true });
    await openDiff();
    expect(app.querySelector(".workspace-diff-hint")?.textContent).toContain("点一行写批注");
    expect(app.querySelectorAll(".diff-comment-btn")).toHaveLength(4);
    expect(app.querySelector(".diff-comment-btn")?.getAttribute("aria-label")).toContain("第");
    await addNote(rowContaining("false"), "keep this");
    expect(app.querySelector(".workspace-diff-hint")).toBeNull();
  });

  test("opens the editor with the line quote above the field", async () => {
    await boot(liveFixture(), { prompt_agent: true, hasAgent: true });
    await openDiff();
    rowContaining("false").click();
    await settle();
    const dialog = document.querySelector("dialog.diff-note-modal");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.querySelector(".modal-title")?.textContent).toContain("第 2 行");
    const quote = dialog?.querySelector(".diff-note-quote");
    const field = dialog?.querySelector(".operation-field");
    expect(quote?.textContent).toContain("第 2 行（旧）");
    expect(quote?.textContent).toContain("false");
    expect(quote && field && Boolean(quote.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTrue();
    dialog?.querySelector("form")?.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    const textarea = document.querySelector<HTMLTextAreaElement>("dialog.diff-note-modal textarea");
    expect(textarea?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("dialog.diff-note-modal .notice-error")?.textContent).toContain("先写一条批注");
  });

  test("keeps the diff scroller in place after saving a comment", async () => {
    await boot(liveFixture(), { prompt_agent: true, hasAgent: true });
    await openDiff();
    const scroller = app.querySelector<HTMLElement>(".workspace-diff");
    if (!scroller) throw new Error("missing diff scroller");
    scroller.scrollTop = 48;
    scroller.scrollLeft = 12;
    await addNote(rowContaining("false"), "stay put");
    const painted = app.querySelector<HTMLElement>(".workspace-diff");
    expect(painted?.dataset.diffKey).toBe("src/app.ts:worktree");
    expect(painted?.scrollTop).toBe(48);
    expect(painted?.scrollLeft).toBe(12);
    expect(app.querySelector(".diff-note-main")).toBeTruthy();
    expect(app.querySelector(".diff-note-actions")).toBeTruthy();
  });
});
