import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../lib/protocol/client";

const { appRoot } = await import("../../app/dom-root.ts");
const app = appRoot();
const { batch } = await import("../../shared/model/domain-store.ts");
const { appHost, commitView } = await import("../../app/host.ts");
const { isAppMounted, mountApp, unmountApp } = await import("../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../app/frame.ts");
const { resetTransitionState } = await import("../../app/transition.ts");
const { setScreen } = await import("../../app/navigation-store.ts");
const { bindKeyboardZones } = await import("../../lib/dom.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../../lib/operations.ts");
const { attachLiveSession } = await import("../computers/catalog-store.ts");
const { setPhase } = await import("../connection/connection-store.ts");
const { openPane } = await import("../connection/controller.ts");
const { applyRuntimeIdentity, runtimeIdentity } = await import("../connection/runtime-store");
const { applySnapshot } = await import("../dashboard/catalog-store.ts");
const { applyCapabilities, clearCapabilities } = await import("../operations/capabilities-store.ts");
const { setPaneTermMode } = await import("../settings/preferences-store.ts");
const { setInspectorOpen } = await import("../workspace/inspector-store.ts");
const { setComposeFocused } = await import("./compose-store.ts");
const { bumpViewIncarnation, resetComposeDrafts } = await import("./drafts/compose-drafts.ts");
const { sessionChosenAt, sessionMayTakeFocus, withholdKeyboardFromSession } = await import("./focus.ts");
const { guidedScrollController } = await import("./guided/guided-scroll.ts");
const { registerSessionView } = await import("./register.ts");
const { applyPaneRead, isAgentChat, openPaneId, resetPaneView, selectPane, setAgentChat, setFullTerminal } =
  await import("./session-store.ts");
const { emulateTouchDevice } = await import("./touch-realm.ts");

/**
 * Who gets the keyboard when the session paints beside the list.
 *
 * A guided commit used to refocus the compose field on every wide layout. With
 * the list and the inspector in view that drags the caret out of them, and a
 * Ctrl+C meant for a selected diff line ends up on its way to the PTY.
 */
const SNAPSHOT = {
  focused: { pane_id: "p1" },
  workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
  panes: ["p1", "p2"].map((paneId) => ({ pane_id: paneId, workspace_id: "w1", agent: "herdr", agent_status: "idle" })),
};

function live(): LiveSession {
  return {
    history: async () => ({ items: [], next_cursor: null, truncated: false }),
    paneRead: async () => ({ text: "ready", hash: "1".repeat(64) }),
    snapshot: async () => SNAPSHOT,
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  } as unknown as LiveSession;
}

function bootGuided(size = { width: 1440, height: 900 }): void {
  happy.happyDOM.setWindowSize(size);
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      applyPaneRead("ready", "h-ready");
      setFullTerminal(false);
      setAgentChat(false);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true }, []);
      applyRuntimeIdentity({ herdHost: runtimeIdentity().herdHost, runtimeKind: "herdr" });
      applySnapshot(SNAPSHOT);
      setPaneTermMode("p1", "guided");
      setPaneTermMode("p2", "guided");
      attachLiveSession(live());
    });
    mountApp();
    commitView();
  });
}

const field = () => app.querySelector<HTMLTextAreaElement>(".main .dock-form textarea");

/** Something focusable the test owns inside a column the shell rendered. */
function plant<K extends "button" | "textarea">(column: string, tag: K): HTMLElementTagNameMap[K] {
  const host = app.querySelector(column);
  if (!host) throw new Error(`missing ${column}`);
  const node = document.createElement(tag);
  host.append(node);
  return node;
}

function press(target: Element): void {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
}

/** A commit that re-runs the pane's paint: the same pane under a new view incarnation. */
function repaint(): void {
  act(() => { bumpViewIncarnation(); commitView(); });
}

let releaseZones: (() => void) | null = null;
let restorePointer: (() => void) | null = null;

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  resetComposeDrafts();
  registerSessionOwnerPreparer(registerSessionView);
  // Production binds this with the page keys; it is what remembers a pressed column.
  releaseZones = bindKeyboardZones(document);
});

afterEach(async () => {
  guidedScrollController.dispose();
  closeTestDialogs();
  restorePointer?.();
  restorePointer = null;
  await act(async () => {
    // Blur before unmounting so no zero-delay blur timer is pending at abort.
    if (document.activeElement instanceof happy.HTMLElement) document.activeElement.blur();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    setInspectorOpen(false);
    unmountApp();
    releaseZones?.();
    releaseZones = null;
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    clearCapabilities();
    setComposeFocused(false);
    selectPane("");
    setScreen("home");
    resetTransitionState();
    resetComposeDrafts();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("guided paint beside the list", () => {
  test("a hardware keyboard types into the session it opened", () => {
    bootGuided();
    expect(field()).not.toBeNull();
    expectSameNode(document.activeElement, field());
  });

  test("a commit does not move focus out of the list", () => {
    bootGuided();
    const row = plant(".rail", "button");
    act(() => row.focus());
    repaint();
    expectSameNode(document.activeElement, row);
    act(() => commitView());
    expectSameNode(document.activeElement, row);
  });

  test("a commit does not move focus out of the inspector", () => {
    bootGuided();
    act(() => { setInspectorOpen(true); commitView(); });
    const note = plant("#app > .inspector", "textarea");
    act(() => note.focus());
    repaint();
    expectSameNode(document.activeElement, note);
  });

  test("a press on a diff line keeps the keyboard in the inspector with focus on the body", () => {
    bootGuided();
    act(() => { setInspectorOpen(true); commitView(); });
    const line = document.createElement("div");
    app.querySelector("#app > .inspector")!.append(line);
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); press(line); });
    expectSameNode(document.activeElement, document.body);

    repaint();
    expectSameNode(document.activeElement, document.body);

    // Pressing back in the session column hands the keyboard back.
    act(() => press(app.querySelector(".main .term")!));
    repaint();
    expectSameNode(document.activeElement, field());
  });

  test("the list giving way to the inspector repaints the header without taking the caret", async () => {
    bootGuided({ width: 1024, height: 768 });
    act(() => { setInspectorOpen(true); commitView(); });
    expect(app.classList.contains("rail-hidden")).toBeTrue();
    // The pane gained a back button: the same session painted again.
    expect(app.querySelector(".main .back")).not.toBeNull();

    const note = plant("#app > .inspector", "textarea");
    await act(async () => {
      note.focus();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    repaint();
    expectSameNode(document.activeElement, note);

    // Closing the column leaves nothing holding the keyboard, so the session has it again.
    act(() => { setInspectorOpen(false); commitView(); });
    expect(app.querySelector(".main .back")).toBeNull();
    expectSameNode(document.activeElement, field());
  });

  test("an open dialog keeps the keyboard", async () => {
    bootGuided();
    // Let the field's own blur settle, so nothing is restoring a focus it still thinks it has.
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    try {
      repaint();
      expectDifferentNode(document.activeElement, field());
    } finally {
      dialog.remove();
    }
  });

  test("choosing another session from the list hands it the keyboard", async () => {
    bootGuided();
    const row = plant(".rail", "button");
    act(() => { press(row); row.focus(); });
    await act(async () => { await openPane("p2"); });
    expect(openPaneId()).toBe("p2");
    expectSameNode(document.activeElement, field());
  });

  test("choosing the open session's own row hands it the keyboard without opening it again", async () => {
    bootGuided();
    const row = plant(".rail", "button");
    act(() => { press(row); row.focus(); });
    // The list holds the keyboard, and a paint alone does not take it back.
    repaint();
    expectSameNode(document.activeElement, row);
    const draft = field()!;
    act(() => {
      draft.value = "half a line";
      draft.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
    });

    await act(async () => { await openPane("p1"); });
    expect(openPaneId()).toBe("p1");
    expectSameNode(document.activeElement, field());
    // The same field with what was in it: nothing was parked and restored.
    expect(field() === draft).toBeTrue();
    expect(field()!.value).toBe("half a line");
  });

  test("the handover from the own row lasts through the next paint, until the reader goes elsewhere", async () => {
    bootGuided();
    const row = plant(".rail", "button");
    const other = plant(".rail", "button");
    act(() => { press(row); row.focus(); });
    await act(async () => { await openPane("p1"); });
    expectSameNode(document.activeElement, field());

    await act(async () => {
      press(other);
      other.focus();
      // Let the field's own blur settle before the paint.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    repaint();
    expectSameNode(document.activeElement, other);
  });

  test("the own row of a chat puts the caret in the chat's field and leaves it a chat", async () => {
    bootGuided();
    act(() => {
      batch(() => {
        // A chat the reader can type into: the daemon takes prompts.
        applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true, prompt_agent: true }, []);
        setAgentChat(true);
      });
      bumpViewIncarnation();
      commitView();
    });
    const chatField = () => app.querySelector<HTMLTextAreaElement>(".main .agent-dock textarea");
    expect(chatField()?.disabled).toBeFalse();
    expectDifferentNode(document.activeElement, chatField());
    const row = plant(".rail", "button");
    act(() => { press(row); row.focus(); });

    await act(async () => { await openPane("p1"); });
    // The stored mode says guided; the session on screen is not re-resolved to it.
    expect(isAgentChat()).toBeTrue();
    expectSameNode(document.activeElement, chatField());
  });

  test("an open dialog keeps the keyboard from the own row too", async () => {
    bootGuided();
    const row = plant(".rail", "button");
    await act(async () => {
      press(row);
      row.focus();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    try {
      await act(async () => { await openPane("p1"); });
      expectSameNode(document.activeElement, row);
    } finally {
      dialog.remove();
    }
  });

  test("a touch tablet's own row raises no keys", async () => {
    restorePointer = emulateTouchDevice();
    bootGuided({ width: 1180, height: 820 });
    const row = plant(".rail", "button");
    act(() => { press(row); row.focus(); });
    await act(async () => { await openPane("p1"); });
    expectSameNode(document.activeElement, row);
  });

  test("a touch tablet remembers the row's choice for the first key a keyboard types", async () => {
    restorePointer = emulateTouchDevice();
    bootGuided({ width: 1180, height: 820 });
    const row = plant(".rail", "button");
    const other = plant(".rail", "button");
    act(() => { press(row); row.focus(); });
    // Focus in the list alone chooses nothing.
    expect(sessionChosenAt(row)).toBeFalse();

    // Its own row, then another session's: each is the handover a mouse gets as focus.
    await act(async () => { await openPane("p1"); });
    expectSameNode(document.activeElement, row);
    expect(sessionChosenAt(row)).toBeTrue();
    await act(async () => { await openPane("p2"); });
    expect(openPaneId()).toBe("p2");
    expectSameNode(document.activeElement, row);
    expect(sessionChosenAt(row)).toBeTrue();
    // Only from where the press left focus.
    expect(sessionChosenAt(other)).toBeFalse();

    // A later press in the list takes the keyboard away, and it does not come back by itself.
    act(() => { press(other); });
    expect(sessionChosenAt(row)).toBeFalse();
    act(() => { press(row); row.focus(); });
    expect(sessionChosenAt(row)).toBeFalse();
  });

  test("a touch tablet never has the field focused for it", () => {
    restorePointer = emulateTouchDevice();
    bootGuided({ width: 1180, height: 820 });
    expect(app.classList.contains("desk")).toBeTrue();
    expectDifferentNode(document.activeElement, field());
    repaint();
    expectDifferentNode(document.activeElement, field());
  });
});

describe("a key that hands focus to a control instead of the session", () => {
  test("the session stays out while that is settling and for as long as focus rests there", async () => {
    bootGuided();
    // The reader left the field for the surface long before closing it.
    await act(async () => {
      field()!.blur();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    const settle = withholdKeyboardFromSession();
    // The surface is closing: the arriving session's paint must not take the caret first.
    expect(sessionMayTakeFocus()).toBeFalse();
    repaint();
    expectDifferentNode(document.activeElement, field());

    const control = plant(".main", "button");
    act(() => { control.focus(); });
    settle(control);
    expect(sessionMayTakeFocus()).toBeFalse();
    expect(sessionMayTakeFocus()).toBeFalse();
    expectSameNode(document.activeElement, control);

    // The reader moves on: the session's own rule is back.
    const next = plant(".main", "button");
    act(() => { next.focus(); });
    expect(sessionMayTakeFocus()).toBeTrue();
    act(() => { control.focus(); });
    expect(sessionMayTakeFocus()).toBeTrue();
  });

  test("nothing is withheld when no control took focus, or when the reader pressed on first", () => {
    bootGuided();
    act(() => { field()!.blur(); });
    withholdKeyboardFromSession()(null);
    expect(sessionMayTakeFocus()).toBeTrue();

    const settle = withholdKeyboardFromSession();
    expect(sessionMayTakeFocus()).toBeFalse();
    act(() => { press(app.querySelector(".main")!); });
    expect(sessionMayTakeFocus()).toBeTrue();
    // Settling late changes nothing: the reader has already gone elsewhere.
    const control = plant(".main", "button");
    settle(control);
    expect(sessionMayTakeFocus()).toBeTrue();
  });
});

describe("sessionMayTakeFocus", () => {
  test("the shell's own inspector class on #app is not a column that holds the keyboard", () => {
    bootGuided();
    act(() => { setInspectorOpen(true); commitView(); });
    expect(app.classList.contains("inspector")).toBeTrue();
    // Focus is in the session column, inside #app.inspector like everything else.
    act(() => field()!.focus());
    expect(sessionMayTakeFocus()).toBeTrue();
  });

  test("the handover after opening a pane lasts until the reader goes somewhere else", async () => {
    bootGuided();
    const row = plant(".rail", "button");
    const other = plant(".rail", "button");
    act(() => { press(row); row.focus(); });
    // No arrival: the list holds the keyboard.
    expect(sessionMayTakeFocus()).toBeFalse();

    act(() => { selectPane("p2"); });
    // Asked more than once before anything takes focus, as the terminal does.
    expect(sessionMayTakeFocus()).toBeTrue();
    expect(sessionMayTakeFocus()).toBeTrue();

    act(() => { press(other); other.focus(); });
    expect(sessionMayTakeFocus()).toBeFalse();
    // And it does not come back by returning to the first row.
    act(() => { press(row); row.focus(); });
    expect(sessionMayTakeFocus()).toBeFalse();
  });
});
