import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { resetHerdAttention } from "../../lib/herd-attention";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { app, clearNotice, state } from "../../state";
import { setRenderer } from "../../paint";
import { renderApp } from "./app-screen";
import { leaveReactScreen } from "./root";
import { mountPaneUnderlay, type PaneUnderlay } from "./pane-underlay";
import { initSwipeBack } from "../pane-swipe";

let stop: (() => void) | undefined;
let standalone: PaneUnderlay | undefined;

beforeEach(async () => {
  await resetBoardTestDOM();
  resetHerdAttention();
  clearNotice();
  Object.assign(state, {
    phase: "live", screen: "pane", paneId: "p1", paneText: "ready", paneHash: "ready",
    boardReturn: false, fullTerminal: false, agentChat: false, paneRow: null, termSelect: false,
    paneFollow: true, paneUnread: false, composeDraft: "", composeIME: false, composeFocused: false,
    composeLive: false, keysExpanded: false, credential: null, computers: [], panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, networkOnline: true, operationBusy: false,
    operationCapabilities: { ...NO_OPERATION_CAPABILITIES },
    agents: [{ paneId: "p1", paneLabel: "Review pane", agent: "codex", status: "idle", hasAgent: true,
      workspaceId: "w1", workspaceLabel: "Project", tabId: "t1", cwd: "/project" }],
  });
  state.live = { isConnected: () => true } as typeof state.live;
  setRenderer(renderApp);
  act(renderApp);
});

afterEach(async () => {
  await act(async () => {
    stop?.(); stop = undefined;
    standalone?.dispose(); standalone = undefined;
    leaveReactScreen();
    await Promise.resolve();
  });
  state.live = null;
  setRenderer(() => {});
});

function touch(type: string, x: number, target: HTMLElement): void {
  const event = new happy.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchmove" || type === "touchstart" ? [{ identifier: 7, clientX: x, clientY: 20 }] : [],
  });
  target.dispatchEvent(event as unknown as Event);
}
function drag(): HTMLElement {
  const root = app.querySelector<HTMLElement>(".pane-root")!;
  touch("touchstart", 10, root);
  touch("touchmove", 150, root);
  return root;
}
async function mutations(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

test("portal disposal remains safe after the app React root is released and recreated immediately", () => {
  act(() => { standalone = mountPaneUnderlay(app, "translateX(-18%) scale(0.94)"); });
  const layer = standalone!.element;
  expect(layer.isConnected).toBeTrue();
  act(() => { leaveReactScreen(); renderApp(); });
  expect(app.querySelectorAll(".pane-root")).toHaveLength(1);
  expect(() => act(() => standalone!.dispose())).not.toThrow();
  expect(layer.isConnected).toBeFalse();
  expect(app.querySelectorAll(".pane-root")).toHaveLength(1);
});

test("gesture retirement preserves an external replacement transform and removes only its owned layer", async () => {
  let backs = 0;
  act(() => { stop = initSwipeBack(() => { backs++; }); });
  const root = app.querySelector<HTMLElement>(".pane-root")!;
  root.style.transform = "translateX(3px)";
  act(drag);
  const oldLayer = app.querySelector(".pane-under")!;
  root.style.transform = "translateX(8px)";
  act(() => stop?.());
  expect(root.style.transform).toBe("translateX(8px)");
  expect(oldLayer.isConnected).toBeFalse();
  expect(root.classList.contains("dragging")).toBeFalse();
  await mutations();
  expect(backs).toBe(0);
});

test("same-pane new-session reconciliation retires an active gesture before any touchend", async () => {
  let backs = 0;
  act(() => { stop = initSwipeBack(() => { backs++; }); });
  let oldRoot!: HTMLElement;
  act(() => { oldRoot = drag(); });
  const layer = app.querySelector(".pane-under")!;
  act(() => {
    state.live = { isConnected: () => true } as typeof state.live;
    renderApp();
  });
  await mutations();
  expect(app.querySelector(".pane-root") === oldRoot).toBeFalse();
  expect(layer.isConnected).toBeFalse();
  expect(oldRoot.classList.contains("dragging")).toBeFalse();
  act(() => touch("touchend", 150, oldRoot));
  expect(backs).toBe(0);
});
