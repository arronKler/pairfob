import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes, diffNotesFor } from "../../lib/diff-notes";
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
 * A half-written line note belongs to its pane, diff and line. The inspector
 * shows it as the form under the line, the workspace screen as a card under the
 * line that opens the sheet; these walk one note between the two.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";

/** Both panes have the same file, so a note that leaked across panes would show. */
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
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

/** A desk session with two panes, the first open with the inspector on its one changed file. */
async function boot(): Promise<void> {
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
    attachLiveSession(liveFixture() as never);
    mountTestApp();
    commitTest();
  });
  await act(async () => { toggleWorkspaceInspector(); });
  await settle();
  await press(inColumn(".workspace-change"));
  expect(workspaceModel.view).toBe("diff");
}

function column(): HTMLElement | null {
  return appRoot().querySelector<HTMLElement>("aside.inspector");
}

function inColumn<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = column()?.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector} in the inspector: ${column()?.innerHTML.slice(0, 400)}`);
  return found;
}

function onScreen<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = appRoot().querySelector<T>(`.workspace-shell ${selector}`);
  if (!found) throw new Error(`missing ${selector} on the workspace screen`);
  return found;
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
  await settle();
}

async function type(textarea: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    textarea.value = text;
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
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

/** What the files button does while the window has no room for the column. */
async function openScreen(): Promise<void> {
  await change(() => enterWorkspace("p1"));
  expect(currentScreen()).toBe("workspace");
  expect(workspaceModel.view).toBe("diff");
}

async function leaveScreen(): Promise<void> {
  await change(() => leaveWorkspace());
  expect(currentScreen()).toBe("pane");
}

/** The form under the line in the inspector; null while none is open. */
function inline(): HTMLTextAreaElement | null {
  return column()?.querySelector<HTMLTextAreaElement>("form.diff-note-inline textarea") ?? null;
}

/** The screen's card for a note that is not saved yet. */
function card(): HTMLElement | null {
  return appRoot().querySelector<HTMLElement>(".workspace-shell .workspace-diff-note.is-draft");
}

function sheet(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("dialog.diff-note-modal textarea");
}

/** The column's card for a note left with Escape. */
function columnCard(): HTMLElement | null {
  return column()?.querySelector<HTMLElement>(".workspace-diff-note.is-draft") ?? null;
}

function escapeKey(target: Element): void {
  target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
}

/**
 * A close request on the sheet, once it is past the moment after opening in
 * which the dialog ignores one. With `key` it is the Escape key; without, it
 * is what a phone's system back sends.
 */
async function closeRequest(key: boolean, pressedOn: () => Element = () => sheet()!): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>("dialog.diff-note-modal");
  if (!dialog) throw new Error("the note sheet is not open");
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 420)); });
  await act(async () => {
    if (key) escapeKey(pressedOn());
    dialog.dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event);
  });
  await settle();
}

/** Half a note on the added line, written in the inspector. */
async function writeInColumn(text: string): Promise<void> {
  await press(inColumn(".workspace-diff-line.diff-add"));
  await type(inline()!, text);
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
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  appRoot().replaceChildren();
});

describe("a half-written note, from the inspector to the workspace screen and back", () => {
  test("the screen shows it under its line, and the column has it back in place", async () => {
    await boot();
    await writeInColumn("half written");

    await resize(800);
    expect(column()).toBeNull();
    await openScreen();
    // It waits under its line: the screen does not open a sheet on its own.
    expect(sheet()).toBeNull();
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("half written");
    expect(card()?.previousElementSibling === onScreen(".workspace-diff-line.diff-add")).toBeTrue();
    expect(card()?.querySelector(".diff-note-resume")?.getAttribute("aria-label")).toBe("给第 2 行写批注");
    // Not a saved note: nothing to send yet.
    expect(diffNotesFor("app.ts", "worktree")).toHaveLength(0);
    expect(appRoot().querySelector(".workspace-notes-bar")).toBeNull();

    await resize(1440);
    // Widening does not leave the screen, and the card is still there.
    expect(currentScreen()).toBe("workspace");
    expect(card()?.textContent).toContain("half written");
    await leaveScreen();
    expect(inline()?.value).toBe("half written");
    expect(inline()?.closest("form")?.previousElementSibling === inColumn(".workspace-diff-line.diff-add")).toBeTrue();
    expect(inColumn(".diff-note-inline-save").hasAttribute("disabled")).toBeFalse();
  });

  test("expanding the column into the screen carries it too", async () => {
    await boot();
    await writeInColumn("carried");
    await change(() => expandWorkspaceInspector());
    expect(currentScreen()).toBe("workspace");
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("carried");
    await leaveScreen();
    expect(inline()?.value).toBe("carried");
  });

  test("what the sheet adds is in the column when the screen goes away under it", async () => {
    await boot();
    await writeInColumn("first half");
    await resize(800);
    await openScreen();
    await press(onScreen(".diff-note-resume"));
    await type(sheet()!, "first half, second half");

    // A jump to the session from elsewhere: the screen and its sheet unmount without an answer.
    await leaveScreen();
    expect(sheet()).toBeNull();
    await resize(1440);
    expect(inline()?.value).toBe("first half, second half");
  });

  test("a note begun in the sheet is kept the same way, and shows on either side", async () => {
    await boot();
    await resize(800);
    await openScreen();
    await press(onScreen(".workspace-diff-line.diff-delete"));
    await type(sheet()!, "begun in the sheet");
    await leaveScreen();

    await openScreen();
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("begun in the sheet");
    expect(card()?.previousElementSibling === onScreen(".workspace-diff-line.diff-delete")).toBeTrue();
    await leaveScreen();
    await resize(1440);
    expect(inline()?.value).toBe("begun in the sheet");
    expect(inline()?.closest("form")?.previousElementSibling === inColumn(".workspace-diff-line.diff-delete")).toBeTrue();
    // Brought back, it waits: the keyboard stays where the reader left it.
    expectDifferentNode(document.activeElement, inline());
  });

  test("it stays with its pane through a session switch, beside the session and on the screen", async () => {
    await boot();
    await writeInColumn("p1 only");

    await change(() => selectPane("p2"));
    await press(inColumn(".workspace-change"));
    // The same file in another pane has no note in progress.
    expect(workspaceModel.paneId).toBe("p2");
    expect(inline()).toBeNull();
    await change(() => selectPane("p1"));
    expect(inline()?.value).toBe("p1 only");

    await resize(800);
    await change(() => selectPane("p2"));
    await change(() => enterWorkspace("p2"));
    expect(workspaceModel.view).toBe("diff");
    expect(card()).toBeNull();
    await leaveScreen();
    await change(() => selectPane("p1"));
    await openScreen();
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("p1 only");
  });
});

describe("the column's editor, back after the window had no room for it", () => {
  const caret = (field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd];

  /** What the reader does somewhere else while the column is away. */
  async function readerActs(type: "pointerdown" | "keydown", key = "a"): Promise<void> {
    await act(async () => {
      const target = appRoot().querySelector(".main") ?? document.body;
      target.dispatchEvent((type === "pointerdown"
        ? new happy.PointerEvent("pointerdown", { bubbles: true })
        : new happy.KeyboardEvent("keydown", { key, bubbles: true })) as unknown as Event);
    });
  }

  test("it has the keyboard again when the reader was typing in it and did nothing in between, after the last word", async () => {
    await boot();
    await writeInColumn("draft one");
    expectSameNode(document.activeElement, inline());
    await resize(800);
    expect(column()).toBeNull();
    // A window is often dragged or tiled with a modifier held: that is not the reader moving on.
    await readerActs("keydown", "Meta");
    await resize(1440);
    const field = inline()!;
    expect(field.value).toBe("draft one");
    expectSameNode(document.activeElement, field);
    // The next words go after the ones already there, not in front of them.
    expect(caret(field)).toEqual([9, 9]);

    // And again: every return is the same handover.
    await resize(800);
    await resize(1440);
    expectSameNode(document.activeElement, inline());
  });

  test("it had no keyboard when the column left: it comes back without one", async () => {
    await boot();
    await writeInColumn("draft one");
    await act(async () => { inline()!.blur(); });
    await resize(800);
    await resize(1440);
    expect(inline()!.value).toBe("draft one");
    expectDifferentNode(document.activeElement, inline());
  });

  for (const moved of ["pointerdown", "keydown"] as const) {
    test(`after a ${moved} somewhere else it waits without the keyboard, and another line pressed resumes it after the last word`, async () => {
      await boot();
      await writeInColumn("draft one");
      await resize(800);
      expect(column()).toBeNull();
      await readerActs(moved);
      await resize(1440);
      const field = inline()!;
      expect(field.value).toBe("draft one");
      expectDifferentNode(document.activeElement, field);
      // Where a browser leaves the caret of a field mounted with text in it.
      field.setSelectionRange(0, 0);

      await press(inColumn(".workspace-diff-line.diff-delete"));
      // Still the one note of this diff, under the line it was written on.
      expect(column()!.querySelectorAll("form.diff-note-inline")).toHaveLength(1);
      expect(inColumn("form.diff-note-inline").previousElementSibling === inColumn(".workspace-diff-line.diff-add")).toBeTrue();
      expect(inline() === field).toBeTrue();
      expectSameNode(document.activeElement, field);
      // The next words go after the ones already there, not in front of them.
      expect(caret(field)).toEqual([9, 9]);
    });
  }

  test("its own line pressed again resumes it the same way", async () => {
    await boot();
    await writeInColumn("draft one");
    await resize(800);
    await readerActs("pointerdown");
    await resize(1440);
    const field = inline()!;
    field.setSelectionRange(0, 0);
    await press(inColumn(".workspace-diff-line.diff-add"));
    expectSameNode(document.activeElement, field);
    expect(caret(field)).toEqual([9, 9]);
  });

  test("a note set aside or cancelled with the keyboard in it does not take the keyboard later", async () => {
    await boot();
    await writeInColumn("draft one");
    await act(async () => { escapeKey(inline()!); });
    await settle();
    expect(columnCard()).not.toBeNull();
    await resize(800);
    await resize(1440);
    expect(inline()).toBeNull();
    expect(columnCard()).not.toBeNull();
  });

  test("an editor that never left keeps the caret where the reader put it", async () => {
    await boot();
    await writeInColumn("draft one");
    const field = inline()!;
    await act(async () => {
      field.setSelectionRange(5, 5);
      field.blur();
    });
    await press(inColumn(".workspace-diff-line.diff-delete"));
    expectSameNode(document.activeElement, field);
    expect(caret(field)).toEqual([5, 5]);
  });
});

describe("an answer on either side lets go of the note on both", () => {
  async function parked(text: string): Promise<void> {
    await boot();
    await writeInColumn(text);
    await resize(800);
    await openScreen();
    expect(card()).not.toBeNull();
  }

  async function backInColumn(): Promise<void> {
    await leaveScreen();
    await resize(1440);
  }

  test("Cancel on the card", async () => {
    await parked("never mind");
    await press(onScreen(".diff-note-discard"));
    expect(card()).toBeNull();
    expect(diffNotesFor("app.ts", "worktree")).toHaveLength(0);
    await backInColumn();
    expect(inline()).toBeNull();
    expect(column()?.querySelector(".workspace-diff-note")).toBeNull();
  });

  test("Save on the card saves the words as they stand", async () => {
    await parked("  keep this  ");
    await press(onScreen(".diff-note-keep"));
    expect(card()).toBeNull();
    expect(diffNotesFor("app.ts", "worktree").map((note) => [note.line, note.body])).toEqual([[2, "keep this"]]);
    expect(onScreen(".workspace-diff-note .diff-note-body").textContent).toBe("keep this");
    expect(onScreen(".workspace-notes-count").textContent).toBe("1 条批注待发送");
    await backInColumn();
    expect(inline()).toBeNull();
    expect(inColumn(".workspace-diff-note").textContent).toContain("keep this");
  });

  test("Cancel in the sheet", async () => {
    await parked("never mind");
    await press(onScreen(".diff-note-resume"));
    await type(sheet()!, "never mind at all");
    await press(document.querySelector<HTMLElement>("dialog.diff-note-modal .text-edit-action")!);
    expect(sheet()).toBeNull();
    expect(card()).toBeNull();
    await backInColumn();
    expect(inline()).toBeNull();
  });

  test("Save in the sheet", async () => {
    await parked("almost");
    await press(onScreen(".diff-note-resume"));
    await type(sheet()!, "almost there");
    await change(() => { sheet()!.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(sheet()).toBeNull();
    expect(card()).toBeNull();
    expect(diffNotesFor("app.ts", "worktree").map((note) => note.body)).toEqual(["almost there"]);
    await backInColumn();
    expect(inline()).toBeNull();
    expect(inColumn(".workspace-diff-note").textContent).toContain("almost there");
  });

  test("Save or Cancel in the column, for a note the screen was showing", async () => {
    await parked("in the column");
    await backInColumn();
    await press(inColumn(".diff-note-inline-cancel"));
    await resize(800);
    await openScreen();
    expect(card()).toBeNull();

    await backInColumn();
    await writeInColumn("saved in the column");
    await change(() => { inline()!.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    await resize(800);
    await openScreen();
    expect(card()).toBeNull();
    expect(onScreen(".workspace-diff-note .diff-note-body").textContent).toBe("saved in the column");
  });
});

describe("the screen's sheet around a note in progress", () => {
  test("one press on the card opens the sheet on the words, ready to go on", async () => {
    await boot();
    await writeInColumn("half written");
    await resize(800);
    await openScreen();
    await press(onScreen(".diff-note-resume"));
    expect(sheet()?.value).toBe("half written");
    expectSameNode(document.activeElement, sheet());
    expect([sheet()?.selectionStart, sheet()?.selectionEnd]).toEqual([12, 12]);
    expect(document.querySelector("dialog.diff-note-modal .text-edit-save")?.hasAttribute("disabled")).toBeFalse();
    expect(document.querySelector("dialog.diff-note-modal .diff-note-count")?.textContent).toBe("12 / 2000");
    // The sheet shows it now, so the card does not say it twice.
    expect(card()).toBeNull();
  });

  test("another line pressed while one is half written opens the sheet on that note", async () => {
    await boot();
    await writeInColumn("not dropped");
    await resize(800);
    await openScreen();
    await press(onScreen(".workspace-diff-line.diff-delete"));
    expect(sheet()?.value).toBe("not dropped");
    expect(document.querySelector("dialog.diff-note-modal .modal-title")?.textContent).toBe("第 2 行批注");
    expect(document.querySelector("dialog.diff-note-modal .diff-note-quote-text")?.textContent).toBe("true");
  });

  test("an edit of a saved note waits beside the note it would replace", async () => {
    await boot();
    await writeInColumn("first");
    await change(() => { inline()!.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    await press(inColumn(".workspace-diff-line.diff-add"));
    expect(inline()?.value).toBe("first");
    await type(inline()!, "first, reworded");
    await resize(800);
    await openScreen();
    const cards = [...appRoot().querySelectorAll(".workspace-shell .workspace-diff-note")];
    expect(cards.map((item) => [item.classList.contains("is-draft"), item.querySelector(".diff-note-body")?.textContent]))
      .toEqual([[false, "first"], [true, "first, reworded"]]);
    expect(card()?.querySelector(".diff-note-resume")?.getAttribute("aria-label")).toBe("编辑第 2 行的批注");
    await press(onScreen(".diff-note-keep"));
    expect(diffNotesFor("app.ts", "worktree").map((note) => note.body)).toEqual(["first, reworded"]);
    expect(card()).toBeNull();
  });

  test("an editor left open with nothing written leaves no card, and the sheet opens where it is pressed", async () => {
    await boot();
    await press(inColumn(".workspace-diff-line.diff-add"));
    expect(inline()?.value).toBe("");
    await resize(800);
    await openScreen();
    expect(card()).toBeNull();
    await press(onScreen(".workspace-diff-line.diff-delete"));
    expect(sheet()?.value).toBe("");
    expect(document.querySelector("dialog.diff-note-modal .modal-title")?.textContent).toBe("第 2 行批注");
    expect(document.querySelector("dialog.diff-note-modal .diff-note-quote-text")?.textContent).toBe("false");
  });

  test("with no note in progress the sheet is what it was: empty on a press, nothing kept after Cancel", async () => {
    await boot();
    await resize(800);
    await openScreen();
    expect(card()).toBeNull();
    await press(onScreen(".workspace-diff-line.diff-add"));
    expect(sheet()?.value).toBe("");
    expect(document.querySelector("dialog.diff-note-modal .text-edit-save")?.hasAttribute("disabled")).toBeTrue();
    await type(sheet()!, "typed, then cancelled");
    await press(document.querySelector<HTMLElement>("dialog.diff-note-modal .text-edit-action")!);
    expect(sheet()).toBeNull();
    expect(card()).toBeNull();
    await press(onScreen(".workspace-diff-line.diff-add"));
    expect(sheet()?.value).toBe("");
  });
});

describe("Escape leaves an editor without an answer, like every other way out", () => {
  test("in the sheet the words wait under their line, and Cancel is still what drops them", async () => {
    await boot();
    await resize(800);
    await openScreen();
    await press(onScreen(".workspace-diff-line.diff-delete"));
    await type(sheet()!, "begun in the sheet");
    await closeRequest(true);

    expect(sheet()).toBeNull();
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("begun in the sheet");
    expect(card()?.previousElementSibling === onScreen(".workspace-diff-line.diff-delete")).toBeTrue();
    expect(diffNotesFor("app.ts", "worktree")).toHaveLength(0);

    await press(onScreen(".diff-note-resume"));
    expect(sheet()?.value).toBe("begun in the sheet");
    await press(document.querySelector<HTMLElement>("dialog.diff-note-modal .text-edit-action")!);
    expect(sheet()).toBeNull();
    expect(card()).toBeNull();
  });

  test("a note resumed in the sheet and left with Escape is still there, on the screen and in the column", async () => {
    await boot();
    await writeInColumn("half written");
    await resize(800);
    await openScreen();
    await press(onScreen(".diff-note-resume"));
    await closeRequest(true);
    expect(sheet()).toBeNull();
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("half written");

    // The reader closed the editor, so the column does not open one either.
    await leaveScreen();
    await resize(1440);
    expect(inline()).toBeNull();
    expect(columnCard()?.querySelector(".diff-note-body")?.textContent).toBe("half written");
  });

  test("set aside in the column, it is the same card on the screen and back", async () => {
    await boot();
    await writeInColumn("aside");
    await act(async () => { escapeKey(inline()!); });
    await settle();
    expect(inline()).toBeNull();
    expect(columnCard()?.querySelector(".diff-note-body")?.textContent).toBe("aside");

    await change(() => expandWorkspaceInspector());
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("aside");
    await leaveScreen();
    expect(inline()).toBeNull();
    expect(columnCard()?.querySelector(".diff-note-body")?.textContent).toBe("aside");

    // Taken up again on the screen and left when the screen goes: the editor was open, so the column opens it.
    await change(() => expandWorkspaceInspector());
    await press(onScreen(".diff-note-resume"));
    await type(sheet()!, "aside, and more");
    await leaveScreen();
    expect(columnCard()).toBeNull();
    expect(inline()?.value).toBe("aside, and more");
  });

  test("the key counts while nothing in the sheet has focus", async () => {
    await boot();
    await resize(800);
    await openScreen();
    await press(onScreen(".workspace-diff-line.diff-delete"));
    await type(sheet()!, "tabbed past the last control");
    // Tab from the sheet's last control leaves the page's focus on <body>; the key never passes through the dialog.
    await act(async () => { sheet()!.blur(); });
    await closeRequest(true, () => document.body);
    expect(sheet()).toBeNull();
    expect(card()?.querySelector(".diff-note-body")?.textContent).toBe("tabbed past the last control");
  });

  test("an empty sheet just closes, and a close request without the key answers as Cancel did", async () => {
    await boot();
    await resize(800);
    await openScreen();
    await press(onScreen(".workspace-diff-line.diff-add"));
    await closeRequest(true);
    expect(sheet()).toBeNull();
    expect(card()).toBeNull();

    // What a phone's system back sends: unchanged, it drops the note as Cancel does.
    await press(onScreen(".workspace-diff-line.diff-add"));
    await type(sheet()!, "typed, then back");
    await closeRequest(false);
    expect(sheet()).toBeNull();
    expect(card()).toBeNull();
  });
});
