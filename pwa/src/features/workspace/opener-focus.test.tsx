import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { sessionHoldsKeys } from "../../app/pane-keys";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { bindKeyboardZones, heldKeyboardZone } from "../../lib/dom";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { sessionMayTakeFocus } from "../session/focus";
import { selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { clearWorkspacePendingReveal, enterWorkspace, leaveWorkspace } from "./index";
import { closeWorkspaceInspector, expandWorkspaceInspector, toggleWorkspaceInspector } from "./inspector";
import { focusLeaving } from "./opener-focus";

/**
 * Where focus is after a files surface opens or closes. A key pressed inside
 * the inspector or the files screen hands focus back to the session header's
 * files button, and the session leaves it there; a key that opens the screen
 * puts focus on its Back, and one that leaves a screen opened from the column
 * puts it back in the column. A mouse or a finger leaves focus on <body>, where
 * the session's own rule picks typing up.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
let releases: Array<() => void> = [];

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
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "app.ts", original_path: null, index: " ", worktree: "M" }],
    }),
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function boot(width = 1440): Promise<void> {
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

async function openInspector(): Promise<void> {
  await act(async () => { toggleWorkspaceInspector(); });
  await settle();
}

function one<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = appRoot().querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}: ${appRoot().innerHTML.slice(0, 300)}`);
  return found;
}

const filesButton = () => one<HTMLButtonElement>(".main .chrome-actions .icon-workspace");

/** Enter on a focused control, the way a keyboard activates it. */
async function enterOn(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    target.click();
  });
  await settle();
}

/** A press with a mouse or a finger; Chrome leaves focus on the pressed button. */
async function pressOn(target: HTMLElement, pointerType: "mouse" | "touch"): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType }) as unknown as Event);
    target.focus();
    target.click();
  });
  await settle();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
  releases = [bindOverlayOrigin(document), bindKeyboardZones(document)];
});

afterEach(async () => {
  unmountTestApp();
  await act(async () => {
    closeWorkspaceInspector();
    if (currentScreen() === "workspace") leaveWorkspace();
    clearWorkspacePendingReveal();
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

describe("the inspector closed from inside it", () => {
  test("Enter on its Close hands focus back to the files button that opened it", async () => {
    await boot();
    await openInspector();
    await enterOn(one(".inspector .inspector-close"));
    expect(appRoot().querySelector("aside.inspector")).toBeNull();
    expectSameNode(document.activeElement, filesButton());
    expect(filesButton().getAttribute("aria-pressed")).toBe("false");
  });

  test("a mouse leaves focus on <body>, and the keys are the session's again", async () => {
    await boot();
    await openInspector();
    await pressOn(one(".inspector .inspector-close"), "mouse");
    expect(appRoot().querySelector("aside.inspector")).toBeNull();
    expectSameNode(document.activeElement, document.body);
    // Nothing beside the session holds the keyboard: what is typed next goes where its rule sends it.
    expect(heldKeyboardZone()).toBeNull();
    expect(sessionHoldsKeys(document.body, heldKeyboardZone())).toBeTrue();
  });

  test("a finger does not move focus either", async () => {
    await boot();
    await openInspector();
    await pressOn(one(".inspector .inspector-close"), "touch");
    expectSameNode(document.activeElement, document.body);
  });

  test("focus that was not in the column stays where it is", async () => {
    await boot();
    await openInspector();
    const more = one<HTMLButtonElement>(".main .chrome-actions .icon-more");
    await act(async () => {
      more.focus();
      more.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "x", bubbles: true }) as unknown as Event);
      closeWorkspaceInspector();
    });
    await settle();
    expectSameNode(document.activeElement, more);
  });

  test("the session leaves the files button its focus, as it does the list", async () => {
    await boot();
    await openInspector();
    await enterOn(one(".inspector .inspector-close"));
    expectSameNode(document.activeElement, filesButton());
    // A complete terminal asks once its bridge is up, long after the close.
    expect(sessionMayTakeFocus()).toBeFalse();
    await act(async () => { one(".main").dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event); });
    expect(sessionMayTakeFocus()).toBeTrue();
  });

  test("a mouse close withholds nothing from the session", async () => {
    await boot();
    await openInspector();
    await pressOn(one(".inspector .inspector-close"), "mouse");
    expect(sessionMayTakeFocus()).toBeTrue();
  });

  test("a session that takes the keyboard as the column closes keeps it", async () => {
    await boot();
    await openInspector();
    const close = one<HTMLButtonElement>(".inspector .inspector-close");
    const field = document.createElement("textarea");
    one(".main").append(field);
    await act(async () => {
      close.focus();
      close.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
      close.click();
      // The session's own arrival rule, on the same commit.
      field.focus();
    });
    await settle();
    expectSameNode(document.activeElement, field);
    field.remove();
  });
});

describe("the files screen left for the session", () => {
  async function expand(): Promise<void> {
    await act(async () => { await expandWorkspaceInspector(); });
    await settle();
    expect(currentScreen()).toBe("workspace");
  }

  test("Enter on the inspector's open-as-a-page puts focus on the screen's Back", async () => {
    await boot();
    await openInspector();
    await enterOn(one(".inspector .inspector-expand"));
    expect(currentScreen()).toBe("workspace");
    expectSameNode(document.activeElement, one(".workspace-shell .back"));
  });

  test("the same button pressed with a mouse leaves focus alone", async () => {
    await boot();
    await openInspector();
    await pressOn(one(".inspector .inspector-expand"), "mouse");
    expect(currentScreen()).toBe("workspace");
    expectSameNode(document.activeElement, document.body);
  });

  /** Escape on whatever has focus, <body> included, the way the screen hears it. */
  async function escape(): Promise<void> {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();
  }

  const expandButton = () => one<HTMLButtonElement>("aside.inspector .inspector-expand");

  test("Enter on Back returns to the column the screen was opened from, and the arriving session leaves focus there", async () => {
    await boot();
    await openInspector();
    // Tab reaches the column long before Enter is pressed in it: the field has let go by then.
    await act(async () => { one(".inspector .inspector-expand").focus(); });
    await settle();
    await enterOn(one(".inspector .inspector-expand"));
    await enterOn(one(".workspace-shell .back"));
    expect(currentScreen()).toBe("pane");
    // The guided session would focus its field on arrival, and Tab typed there is the program's.
    expectSameNode(document.activeElement, expandButton());
    expect(sessionMayTakeFocus()).toBeFalse();
    // Asked again later, as a complete terminal asks once its bridge is up: still no.
    await act(async () => { commitTest(); });
    await settle();
    expectSameNode(document.activeElement, expandButton());
    expect(sessionMayTakeFocus()).toBeFalse();

    // Until the reader presses or focuses somewhere else.
    const more = one<HTMLButtonElement>(".main .chrome-actions .icon-more");
    await act(async () => { more.focus(); });
    expect(sessionMayTakeFocus()).toBeTrue();
  });

  test("Esc leaves the screen for the column, and goes on closing: the column next, back to the files button", async () => {
    await boot();
    await openInspector();
    // As above: the reader has been in the column for a while by the time they open the page.
    await act(async () => { one(".inspector .inspector-expand").focus(); });
    await settle();
    await enterOn(one(".inspector .inspector-expand"));
    expectSameNode(document.activeElement, one(".workspace-shell .back"));
    await escape();
    expect(currentScreen()).toBe("pane");
    expectSameNode(document.activeElement, expandButton());
    // In the column, so the key is the column's and not the running program's.
    expect(sessionHoldsKeys(document.activeElement, heldKeyboardZone())).toBeFalse();
    await escape();
    expect(appRoot().querySelector("aside.inspector")).toBeNull();
    expectSameNode(document.activeElement, filesButton());
  });

  test("a mouse opened the page and Esc left it: the key is still answered in the column", async () => {
    await boot();
    await openInspector();
    await pressOn(one(".inspector .inspector-expand"), "mouse");
    expectSameNode(document.activeElement, document.body);
    await escape();
    expect(currentScreen()).toBe("pane");
    expectSameNode(document.activeElement, expandButton());
    expect(sessionMayTakeFocus()).toBeFalse();
    await escape();
    expect(appRoot().querySelector("aside.inspector")).toBeNull();
  });

  test("with no column to return to, Esc with nothing focused hands nothing to the files button", async () => {
    await boot(800);
    await act(async () => {
      one(".main").dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
      await enterWorkspace("p1");
    });
    await settle();
    expect(currentScreen()).toBe("workspace");
    expectSameNode(document.activeElement, document.body);
    await escape();
    expect(currentScreen()).toBe("pane");
    expectDifferentNode(document.activeElement, filesButton());
    expect(sessionMayTakeFocus()).toBeTrue();
  });

  test("Enter on Back hands focus to the files button when the session leaves it lost", async () => {
    happy.happyDOM.setWindowSize({ width: 800, height: 900 });
    appRoot().className = "desk";
    appRoot().innerHTML = `<section class="main"><div class="chrome-actions"><button class="icon-workspace"></button></div></section>
      <div class="workspace-shell"><button class="back"></button></div>`;
    const back = one<HTMLButtonElement>(".workspace-shell .back");
    back.focus();
    back.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    const handBack = focusLeaving(".workspace-shell");
    one(".workspace-shell").remove();
    handBack();
    // Not before the close has settled.
    expectDifferentNode(document.activeElement, filesButton());
    await settle();
    expectSameNode(document.activeElement, filesButton());
  });

  test("nothing moves while a dialog is still open over the session", async () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    appRoot().className = "desk";
    appRoot().innerHTML = `<section class="main"><div class="chrome-actions"><button class="icon-workspace"></button></div></section>
      <div class="workspace-shell"><button class="back"></button></div>`;
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
    const back = one<HTMLButtonElement>(".workspace-shell .back");
    back.focus();
    back.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    const handBack = focusLeaving(".workspace-shell");
    one(".workspace-shell").remove();
    handBack();
    await settle();
    expectDifferentNode(document.activeElement, filesButton());
    dialog.close();
    dialog.remove();
  });

  test("Back with a mouse leaves focus to the session's own rule", async () => {
    await boot();
    await openInspector();
    await expand();
    await pressOn(one(".workspace-shell .back"), "mouse");
    expect(currentScreen()).toBe("pane");
    expectDifferentNode(document.activeElement, filesButton());
    expect(sessionHoldsKeys(document.body, heldKeyboardZone())).toBeTrue();
  });

  test("the phone layout is left alone, whatever key leaves the screen", async () => {
    await boot(390);
    await act(async () => {
      setScreen("workspace");
      commitTest();
    });
    await settle();
    const back = appRoot().querySelector<HTMLButtonElement>(".workspace-shell .back");
    if (!back) throw new Error("no files screen on the phone layout");
    await enterOn(back);
    expect(document.activeElement?.matches(".icon-workspace") ?? false).toBeFalse();
  });
});
