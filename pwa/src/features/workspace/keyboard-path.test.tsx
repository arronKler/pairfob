import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { bindKeyboardZones } from "../../lib/dom";
import { setLang } from "../../lib/i18n";
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

/**
 * The files surfaces worked with the keyboard alone: what Tab stops on, what
 * the arrows move, what each Esc closes, and where focus is afterwards. The
 * inspector at 1440px, the screen at 800px (one pane at a time).
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const PATCH = "@@ -1,3 +1,3 @@\n keep\n-false\n+true\n tail\n";
let releases: Array<() => void> = [];
/** Reads the test holds open, by method: a slow computer. */
let gates = new Map<string, Promise<void>>();

function hold(method: string): () => void {
  let open!: () => void;
  gates.set(method, new Promise<void>((resolve) => { open = resolve; }));
  return () => {
    gates.delete(method);
    open();
  };
}

function liveFixture() {
  const gated = async <T,>(method: string, value: T): Promise<T> => {
    await gates.get(method);
    return value;
  };
  return {
    isConnected: () => true,
    paneRead: async () => ({ text: "", hash: "h" }),
    workspaceOpen: async (pane: string) => gated("workspaceOpen", {
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
      changes: [
        { path: "app.ts", original_path: null, index: " ", worktree: "M" },
        { path: "lib.ts", original_path: null, index: " ", worktree: "M" },
      ],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: PATCH, additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({ items: [], truncated: false, revision }),
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

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
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/p1", agent: "codex", agent_status: "idle" as const }],
    });
    attachLiveSession(liveFixture() as never);
    mountTestApp();
    commitTest();
  });
}

function one<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = appRoot().querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}: ${appRoot().innerHTML.slice(0, 300)}`);
  return found;
}

const filesButton = () => one<HTMLButtonElement>(".main .chrome-actions .icon-workspace");
const focused = () => document.activeElement as HTMLElement;
const row = (path: string) => one<HTMLButtonElement>(`[data-change="worktree:${path}"]`);

/** A key on whatever has focus; Enter and Space also press a button, as the engine would. */
async function key(name: string): Promise<KeyboardEvent> {
  const target = focused();
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  await act(async () => {
    target.dispatchEvent(event);
    if ((name === "Enter" || name === " ") && !event.defaultPrevented && target.matches("button")) target.click();
  });
  await settle();
  return event;
}

/** Focus as Tab leaves it: on `target`, with whatever had it before long since let go. */
async function focusOn(target: HTMLElement): Promise<void> {
  await act(async () => { target.focus(); });
  await settle();
}

/** A press with a mouse; Chrome leaves focus on the pressed button. */
async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
    target.focus();
    target.click();
  });
  await settle();
}

async function openColumnByKey(): Promise<void> {
  await focusOn(filesButton());
  await key("Enter");
}

async function openScreenByKey(): Promise<void> {
  await focusOn(filesButton());
  await key("Enter");
  expect(currentScreen()).toBe("workspace");
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
  gates = new Map();
  releases = [bindOverlayOrigin(document), bindKeyboardZones(document)];
});

// One test stands in for `checkVisibility`; later files get back whatever the DOM had before.
const ownCheckVisibility = Object.getOwnPropertyDescriptor(happy.Element.prototype, "checkVisibility");

afterEach(async () => {
  if (ownCheckVisibility) Object.defineProperty(happy.Element.prototype, "checkVisibility", ownCheckVisibility);
  else delete (happy.Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  for (const open of [...gates.keys()]) gates.delete(open);
  unmountTestApp();
  await act(async () => {
    closeWorkspaceInspector();
    if (currentScreen() === "workspace") leaveWorkspace();
    clearWorkspacePendingReveal();
    clearAllDiffNotes();
    closeTestDialogs();
    disposeNoticeLifecycle();
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  for (const release of releases) release();
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("the inspector by keyboard", () => {
  test("Enter on the files button opens the column and hands it the keyboard, on its selected tab", async () => {
    await boot(1440);
    await openColumnByKey();
    expect(inspectorOpen()).toBeTrue();
    expectSameNode(focused(), one(".inspector-tab[aria-selected='true']"));
  });

  test("a mouse on the files button opens it and leaves focus where it was", async () => {
    await boot(1440);
    await click(filesButton());
    expect(inspectorOpen()).toBeTrue();
    expectSameNode(focused(), filesButton());
  });

  test("the tabs are one stop; arrows, Home and End move between them and show the one they land on", async () => {
    await boot(1440);
    await openColumnByKey();
    const tabs = () => [...appRoot().querySelectorAll<HTMLButtonElement>(".inspector-tab")];
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1]);
    expect((await key("ArrowRight")).defaultPrevented).toBeTrue();
    expect(workspaceModel.tab).toBe("files");
    expectSameNode(focused(), tabs()[1]);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0]);
    await key("ArrowRight");
    expect(workspaceModel.tab).toBe("changes");
    await key("End");
    expect(workspaceModel.tab).toBe("files");
    await key("Home");
    expect(workspaceModel.tab).toBe("changes");
    expectSameNode(focused(), tabs()[0]);
    // Any other key is not the tab list's.
    expect((await key("ArrowDown")).defaultPrevented).toBeFalse();
  });

  test("Enter on a row opens its diff with focus on the way back; each Esc closes one thing and says where focus went", async () => {
    await boot(1440);
    await openColumnByKey();
    await focusOn(row("lib.ts"));
    await key("Enter");
    expect(workspaceModel.view).toBe("diff");
    expectSameNode(focused(), one(".inspector-switch-file"));

    expect((await key("Escape")).defaultPrevented).toBeTrue();
    expect(workspaceModel.view).toBe("browser");
    expect(inspectorOpen()).toBeTrue();
    expectSameNode(focused(), row("lib.ts"));

    expect((await key("Escape")).defaultPrevented).toBeTrue();
    expect(inspectorOpen()).toBeFalse();
    expectSameNode(focused(), filesButton());
  });

  test("a note left open is what Esc closes first, wherever in the diff the key is pressed", async () => {
    await boot(1440);
    await openColumnByKey();
    await focusOn(row("app.ts"));
    await key("Enter");
    const line = one<HTMLButtonElement>(".workspace-inspector .diff-add .diff-comment-btn");
    await focusOn(line);
    await key("Enter");
    const field = one<HTMLTextAreaElement>("form.diff-note-inline textarea");
    await act(async () => {
      field.value = "why true";
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await focusOn(line);
    await key("Escape");
    expect(appRoot().querySelector("form.diff-note-inline")).toBeNull();
    expect(one(".workspace-diff-note.is-draft").textContent).toContain("why true");
    expect(workspaceModel.view).toBe("diff");
    await key("Escape");
    expect(workspaceModel.view).toBe("browser");
  });

  test("the lines of a diff are one stop, and the arrows move along them", async () => {
    await boot(1440);
    await openColumnByKey();
    await focusOn(row("app.ts"));
    await key("Enter");
    const lines = () => [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-inspector .diff-comment-btn")];
    expect(lines().length).toBeGreaterThan(2);
    expect(lines().map((line) => line.tabIndex)).toEqual([0, ...lines().slice(1).map(() => -1)]);
    await focusOn(lines()[0]);
    expect((await key("ArrowDown")).defaultPrevented).toBeTrue();
    expectSameNode(focused(), lines()[1]);
    expect(lines().map((line) => line.tabIndex).indexOf(0)).toBe(1);
    await key("End");
    expectSameNode(focused(), lines().at(-1));
    await key("ArrowDown");
    expectSameNode(focused(), lines().at(-1));
    await key("Home");
    expectSameNode(focused(), lines()[0]);
    expect(lines().filter((line) => line.tabIndex === 0)).toHaveLength(1);
  });

  test("a control that disables itself for its own read gets the keyboard back when the read lands", async () => {
    await boot(1440);
    await openColumnByKey();
    const refresh = one<HTMLButtonElement>(".inspector-actions .icon-btn");
    await focusOn(refresh);
    const land = hold("workspaceOpen");
    await key("Enter");
    expect(refresh.disabled).toBeTrue();
    // Waiting on the column, so no key goes next door meanwhile.
    expectSameNode(focused(), one(".workspace-inspector"));
    await act(async () => { land(); });
    await settle();
    expect(refresh.disabled).toBeFalse();
    expectSameNode(focused(), refresh);
  });

  test("the last step of the review hands focus to the step that is still open", async () => {
    await boot(1440);
    await openColumnByKey();
    await focusOn(row("app.ts"));
    await key("Enter");
    const [previous, next] = [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-inspector .workspace-step")];
    expect(previous.disabled).toBeTrue();
    await focusOn(next);
    await key("Enter");
    expect(workspaceModel.detailPath).toBe("lib.ts");
    expect(next.disabled).toBeTrue();
    expectSameNode(focused(), previous);
  });
});

describe("the files screen by keyboard", () => {
  /** The style sheet hides the list under an open detail below 900px; the test DOM lays nothing out. */
  function hideListUnderDetail(): void {
    (happy.Element.prototype as { checkVisibility?: (this: Element) => boolean }).checkVisibility = function () {
      return this.closest(".workspace-shell.detail .workspace-nav") === null;
    };
  }

  test("the tabs are one stop there too, in the order the inspector shows them", async () => {
    await boot(800);
    await openScreenByKey();
    const tabs = () => [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-tab")];
    // Changes first, as beside the session: the same list at another width.
    expect(tabs().map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["更改", "文件"]);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1]);
    await focusOn(tabs()[0]);
    await key("ArrowRight");
    expect(workspaceModel.tab).toBe("files");
    expectSameNode(focused(), tabs()[1]);
    await key("Home");
    expect(workspaceModel.tab).toBe("changes");
    expectSameNode(focused(), tabs()[0]);
  });

  test("Enter on a row covers the list, and focus goes to the detail's Back; Esc returns to the row, then to the session", async () => {
    hideListUnderDetail();
    await boot(800);
    await openScreenByKey();
    expectSameNode(focused(), one(".workspace-shell .back"));
    await focusOn(row("lib.ts"));
    await key("Enter");
    expect(workspaceModel.view).toBe("diff");
    expectSameNode(focused(), one(".workspace-shell .back"));
    expect(focused().getAttribute("aria-label")).toBe("返回列表");

    // Back itself: it outlives the detail, so the row takes focus rather than the button that now leaves the screen.
    await key("Enter");
    expect(workspaceModel.view).toBe("browser");
    expectSameNode(focused(), row("lib.ts"));

    await key("Enter");
    await focusOn(one(".workspace-shell .diff-comment-btn"));
    expect((await key("Escape")).defaultPrevented).toBeTrue();
    expect(workspaceModel.view).toBe("browser");
    expect(currentScreen()).toBe("workspace");
    expectSameNode(focused(), row("lib.ts"));

    expect((await key("Escape")).defaultPrevented).toBeTrue();
    expect(currentScreen()).toBe("pane");
    expectSameNode(focused(), filesButton());
  });

  test("Esc is the top layer's while a sheet is open, and leaves a mouse's focus alone on the way out", async () => {
    await boot(800);
    await act(async () => { await enterWorkspace("p1"); });
    await settle();
    await click(row("app.ts"));
    await click(one(".workspace-shell .diff-add"));
    const sheet = document.querySelector<HTMLDialogElement>("dialog.diff-note-modal")!;
    expect(sheet.open).toBeTrue();
    const event = new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event;
    await act(async () => { sheet.querySelector("textarea")!.dispatchEvent(event); });
    // The sheet answers its own Escape (`dialog-lifecycle`); the screen under it closes nothing.
    expect(workspaceModel.view).toBe("diff");
    expect(currentScreen()).toBe("workspace");
    await act(async () => { sheet.close(); });
    await settle();

    // No focus anywhere: the reader got here with the mouse. The key still closes what is on top.
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    const first = new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event;
    await act(async () => { document.body.dispatchEvent(first); });
    await settle();
    expect(first.defaultPrevented).toBeTrue();
    expect(workspaceModel.view).toBe("browser");
    await act(async () => { document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
    await settle();
    expect(currentScreen()).toBe("pane");
    // Nothing was handed to the files button: where typing goes is the session's own rule again.
    expectDifferentNode(focused(), filesButton());
  });

  test("a held modifier, or the input method, keeps Esc from closing anything", async () => {
    await boot(800);
    await openScreenByKey();
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { isComposing: true }]) {
      const event = new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }) as unknown as Event;
      await act(async () => { focused().dispatchEvent(event); });
      expect(event.defaultPrevented).toBeFalse();
      expect(currentScreen()).toBe("workspace");
    }
  });
});

describe("opening without a key", () => {
  test("toggling the column from code moves no focus", async () => {
    await boot(1440);
    await focusOn(filesButton());
    await act(async () => { toggleWorkspaceInspector(); });
    await settle();
    expectSameNode(focused(), filesButton());
  });
});
