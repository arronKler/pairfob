import { happy, resetTestDOM } from "../../../test-support/boot-dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { app, replaceAgentsFromSnapshot, state } from "../../state";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { boardPreviewText, clearBoardPreviews, refreshBoardPreviews } from "../board-preview";
import { releaseBoardScroll } from "../board-canvas";
import { BoardCanvas } from "./board-canvas";
import { leaveReactScreen, renderReactScreen } from "./root";
import { renderApp } from "./app-screen";

function snapshot(withPane: boolean) {
  return {
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: withPane ? "w1:p1" : "" },
    workspaces: [{ workspace_id: "w1", label: "Workspace" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Main" }],
    panes: withPane ? [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", agent: "codex", agent_status: "idle", label: "Pane" }] : [],
    layouts: [],
  };
}

beforeEach(async () => {
  await resetTestDOM();
  Object.assign(globalThis, {
    Element: happy.Element, PointerEvent: happy.PointerEvent, WheelEvent: happy.WheelEvent,
    getComputedStyle: happy.getComputedStyle.bind(happy),
    requestAnimationFrame: happy.requestAnimationFrame.bind(happy),
    cancelAnimationFrame: happy.cancelAnimationFrame.bind(happy),
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.assign(state, { phase: "live", screen: "board", networkOnline: true,
    boardWorkspaceId: "w1", boardTabId: "w1:t1", boardFitted: true, boardScale: 1, boardPanX: 0, boardPanY: 0,
    agents: [], layouts: [], paneId: "", operationBusy: false, operationCapabilities: { ...NO_OPERATION_CAPABILITIES } });
  state.live = { isConnected: () => true, paneRead: async () => ({ text: "", hash: "" }) } as typeof state.live;
});

afterEach(() => {
  act(() => { leaveReactScreen(); clearBoardPreviews(); });
  closeTestDialogs();
  releaseBoardScroll();
  state.live = null;
  state.screen = "home";
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

function paint(): void { act(() => renderReactScreen(<BoardCanvas />)); }

test("clearing previews and changing session rejects the old in-flight read before publishing to React", async () => {
  replaceAgentsFromSnapshot(snapshot(true));
  let complete!: (value: { text: string; hash: string }) => void;
  let reads = 0;
  state.live = { isConnected: () => true, paneRead: () => {
    reads++;
    return new Promise(resolve => { complete = resolve; });
  } } as typeof state.live;
  paint();
  const tile = app.querySelector(".board-pane")!;
  const pending = refreshBoardPreviews();
  await Promise.resolve();
  expect(reads).toBe(1);
  act(() => clearBoardPreviews());
  state.live = { isConnected: () => true, paneRead: async () => ({ text: "new computer", hash: "new" }) } as typeof state.live;
  paint();
  await act(async () => { complete({ text: "old computer private output", hash: "old" }); await pending; });
  expect(app.querySelector(".board-pane") === tile).toBeTrue();
  expect(tile.querySelector(".board-pane-screen")!.textContent).not.toContain("old computer private output");
  expect(boardPreviewText("w1:p1")).toBe("");
});

test("an empty tab gaining fallback panes binds gestures despite the unchanged explicit-layout signature", () => {
  replaceAgentsFromSnapshot(snapshot(false));
  const signature = state.lastLayoutSig;
  paint();
  const viewport = app.querySelector<HTMLElement>(".board-canvas")!;
  expect(app.querySelector(".board-stage")).toBeNull();
  replaceAgentsFromSnapshot(snapshot(true));
  expect(state.lastLayoutSig).toBe(signature);
  paint();
  expect(app.querySelector(".board-canvas") === viewport).toBeTrue();
  expect(app.querySelector(".board-stage") !== null).toBeTrue();
  const before = state.boardScale;
  act(() => viewport.dispatchEvent(new happy.WheelEvent("wheel", {
    bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1, clientX: 30, clientY: 40,
  }) as unknown as Event));
  expect(state.boardScale).toBeGreaterThan(before);
});

test("removing a fallback stage retires the in-progress gesture on its retained viewport", () => {
  replaceAgentsFromSnapshot(snapshot(true));
  paint();
  const viewport = app.querySelector<HTMLElement>(".board-canvas")!;
  act(() => viewport.dispatchEvent(new happy.PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10,
  }) as unknown as Event));
  replaceAgentsFromSnapshot(snapshot(false));
  paint();
  expect(app.querySelector(".board-canvas") === viewport).toBeTrue();
  expect(app.querySelector(".board-stage")).toBeNull();
  const before = state.boardPanX;
  act(() => viewport.dispatchEvent(new happy.PointerEvent("pointermove", {
    bubbles: true, cancelable: true, pointerId: 1, clientX: 60, clientY: 10,
  }) as unknown as Event));
  expect(state.boardPanX).toBe(before);
});

test("the actual board route keeps capability and connection gates before opening a scoped tab form", () => {
  replaceAgentsFromSnapshot(snapshot(true));
  state.agentKinds = [];
  let mutations = 0;
  let connected = true;
  state.live = { isConnected: () => connected, createTab: async () => { mutations++; } } as typeof state.live;
  act(renderApp);
  expect(app.classList.contains("board")).toBeTrue();
  expect(app.querySelector(".board-tab-new")).toBeNull();
  state.operationCapabilities.create_tab = true;
  state.operationBusy = true;
  act(renderApp);
  const create = app.querySelector<HTMLButtonElement>(".board-tab-new")!;
  expect(create.disabled).toBeTrue();
  act(() => create.click());
  expect(document.querySelector("dialog")).toBeNull();
  state.operationBusy = false;
  connected = false;
  act(renderApp);
  expect(app.querySelector(".board-tab-new") === create).toBeTrue();
  expect(create.disabled).toBeTrue();
  connected = true;
  act(renderApp);
  expect(create.disabled).toBeFalse();
  act(() => create.click());
  const cwd = document.querySelector<HTMLInputElement>('dialog input[name="cwd"]');
  expect(cwd?.value).toBe("/repo");
  expect(state.screen).toBe("board");
  expect(mutations).toBe(0);
});
