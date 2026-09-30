import { resetChatDOM } from "../../../test-support/chat-dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { act } from "react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountApp, unmountApp } from "../../app/mount";
import { commitView } from "../../app/host";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot } from "../../features/dashboard/catalog-store";
import { focusBoard, selectBoardTab, setBoardCamera, liveBoardCamera, liveBoardCatalog } from "../../features/board/layout-store";
import { boardInteractionStore, clearBoardInteraction } from "../../features/board/interaction-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { noteSnapshotAt, openPaneId, selectPane } from "../../features/session/session-store";
import { resetGenerationsForTests } from "../../features/connection/generations";
import { resetComposeDrafts } from "../../features/session/drafts/compose-drafts";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { ProtocolError } from "../../lib/protocol/errors";
import { openBoardPaneMenu } from "./pane-menu";
import { pickBoardSplit } from "./board-bridge";
import type { SnapshotWire } from "../../lib/dashboard";

const caps = { ...NO_OPERATION_CAPABILITIES, split_pane: true, resize_pane: true, swap_pane: true, zoom_pane: true };
let snapshot: SnapshotWire;
let calls: Array<{ method: string; value: unknown }>;
let failure = false;
let connected = true;
let splitWait: Promise<void> | undefined;
const projectionRestorer = new WorkspaceSnapshotRestorer();

beforeEach(async () => {
  await resetChatDOM();
  projectionRestorer.capture();
  connected = true; failure = false; calls = []; splitWait = undefined;
  resetGenerationsForTests(); resetComposeDrafts(); setOperationBusy(false); clearBoardInteraction();
  setLang("zh"); setPhase("live"); setNetworkOnline(true); setScreen("board"); selectPane("p1"); noteSnapshotAt(Date.now());
  registerSessionOwnerPreparer(registerSessionView);
  snapshot = { workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ workspace_id: "w1", tab_id: "t1", label: "tab one" }, { workspace_id: "w1", tab_id: "t2", label: "tab two" }],
    panes: ["p1", "p2"].map(pane_id => ({ pane_id, workspace_id: "w1", tab_id: "t1", cwd: "/tmp/demo", label: pane_id, agent: "", agent_status: "idle" })),
    layouts: [{ workspace_id: "w1", tab_id: "t1", zoomed: false, focused_pane_id: "p1", area: { x: 0, y: 0, width: 100, height: 40 },
      panes: ["p1", "p2"].map((pane_id, index) => ({ pane_id, focused: index === 0, rect: { x: index * 50, y: 0, width: 50, height: 40 } })) }],
  };
  const mutation = async (method: string, value: unknown) => {
    calls.push({ method, value });
    if (failure) throw new ProtocolError("unknown_outcome", "unknown_outcome");
    return { operation_id: "op_board0000000001", outcome: "applied" as const };
  };
  attachLiveSession({ isConnected: () => connected, snapshot: async () => snapshot,
    paneRead: async () => ({ text: "pane", hash: "hash" }),
    resizePane: input => mutation("resize", input), swapPane: input => mutation("swap", input), zoomPane: input => mutation("zoom", input),
    renamePane: async (id, label) => { await mutation("rename", { id, label }); },
    closePane: async id => { await mutation("close", id); snapshot.panes = snapshot.panes?.filter(pane => pane.pane_id !== id); },
    splitPane: async input => {
      await mutation("split", input);
      await splitWait;
      snapshot.panes!.push({ pane_id: "p3", workspace_id: "w1", tab_id: "t1", cwd: "/tmp/demo", agent: "" });
      return { operation_id: "op_board0000000001", outcome: "applied", pane_id: "p3", workspace_id: "w1", tab_id: "t1" };
    },
  });
  applyCapabilities(caps, []); replaceAgentsFromSnapshot(snapshot); focusBoard("w1", "t1");
  act(() => { mountApp(); commitView(); });
});
afterEach(async () => {
  closeTestDialogs();
  await act(async () => { await Promise.resolve(); });
  act(() => unmountApp()); clearBoardInteraction(); attachLiveSession(null); setOperationBusy(false);
  projectionRestorer.restore();
});

async function open() {
  const tile = document.querySelector<HTMLElement>('.board-pane[data-pane-id="p2"]')!;
  let finished!: Promise<void>;
  await act(async () => { finished = openBoardPaneMenu("p2", { x: 180, y: 300 }, tile, { openPane: () => {}, revealPane: () => {} }); });
  return { finished };
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(button =>
    (button.querySelector(".menu-choice-title")?.textContent ?? button.textContent)?.trim() === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => { button.click(); await Promise.resolve(); });
}

const rows = () => [...document.querySelectorAll<HTMLButtonElement>("dialog .menu-choice")];
const row = (label: string) => rows().find(button => button.querySelector(".menu-choice-title")?.textContent === label);
async function stepper(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`dialog button[aria-label="${label}"]`);
  if (!button) throw new Error(`Stepper not found: ${label}`);
  await act(async () => { button.click(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function splitSheet(direction: "right" | "down") {
  await act(async () => { pickBoardSplit("p2", direction); await Promise.resolve(); });
  expect(document.querySelector("dialog.board-split-sheet")).not.toBeNull();
}

test("the menu groups this session, its layout and management, with the pane named in the head", async () => {
  await open();
  expect([...document.querySelectorAll("dialog .menu-section-title")].map(node => node.textContent))
    .toEqual([t("boardMenu.groupPane"), t("boardMenu.groupLayout"), t("boardMenu.groupManage")]);
  expect(rows().map(button => button.querySelector(".menu-choice-title")?.textContent)).toEqual([
    t("boardMenu.open"), t("boardMenu.rename"), t("boardMenu.split"), t("boardMenu.resize"), t("boardMenu.swapPick"),
    t("boardMenu.maximize"), t("boardMenu.close"),
  ]);
  expect(document.querySelector("dialog .sheet-subtitle")?.textContent).toContain(t("boardMenu.positionH", { h: t("boardMenu.h.right") }));
  expect(document.querySelector(".board-context-menu, .board-menu-overlay")).toBeNull();
});

test("split starts placement on the canvas; the picked side splits the pressed pane and stays on the board", async () => {
  const { finished } = await open();
  await click(t("boardMenu.split")); await act(async () => { await finished; });
  expect(boardInteractionStore.get()).toMatchObject({ placementKind: "split", placementPaneId: "p2", tabId: "t1" });
  await splitSheet("down");
  expect(document.querySelector("dialog .create-summary")?.textContent)
    .toBe(t("boardMenu.splitSummaryDown", { title: "p2", kind: t("create.terminal") }));
  await click(t("boardMenu.splitSubmit"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(calls).toEqual([{ method: "split", value: { pane_id: "p2", direction: "down", ratio: 0.5, cwd: "/tmp/demo" } }]);
  expect(openPaneId()).toBe("p1"); expect(currentScreen()).toBe("board");
  expect(boardInteractionStore.get().createdPaneId).toBe("p3");
});

test("swap starts the neighbour pick on the canvas instead of a list of directions", async () => {
  const { finished } = await open();
  await click(t("boardMenu.swapPick")); await act(async () => { await finished; });
  expect(boardInteractionStore.get()).toMatchObject({ placementKind: "swap", placementPaneId: "p2" });
  expect(calls).toEqual([]);
});

test("resize steps move this pane's own divider the way herdr applies it, and recheck capabilities", async () => {
  const { finished } = await open(); await click(t("boardMenu.resize")); await act(async () => { await finished; });
  expect(document.querySelector("dialog.board-resize-sheet")).not.toBeNull();
  expect(document.querySelector("dialog .menu-setting-label small")?.textContent)
    .toBe(t("boardMenu.dividerSide", { side: t("boardMenu.side.left"), n: 50 }));
  // p2 is the right-hand pane: wider moves the divider left, naming the pane whose left edge it is.
  await stepper(t("form.wider"));
  expect(calls).toEqual([{ method: "resize", value: { pane_id: "p2", direction: "left", amount: 0.05 } }]);
  await stepper(t("form.narrower"));
  expect(calls.at(-1)).toEqual({ method: "resize", value: { pane_id: "p1", direction: "right", amount: 0.05 } });
  expect(document.querySelector("dialog")?.textContent).toContain(t("boardMenu.done"));
  expect(document.querySelector<HTMLButtonElement>(`dialog button[aria-label="${t("form.taller")}"]`)!.disabled).toBe(true);
  await act(async () => applyCapabilities(NO_OPERATION_CAPABILITIES, []));
  expect(document.querySelector<HTMLButtonElement>(`dialog button[aria-label="${t("form.wider")}"]`)!.disabled).toBe(true);
  expect(calls).toHaveLength(2);
});

test("changing tabs closes the menu and retires a pending split sheet even if the tab returns", async () => {
  let opened = await open();
  await act(async () => { selectBoardTab("t2"); await Promise.resolve(); });
  await opened.finished;
  expect(document.querySelector("dialog")).toBeNull();
  await act(async () => selectBoardTab("t1"));
  opened = await open(); await click(t("boardMenu.split")); await act(async () => { await opened.finished; });
  await splitSheet("right");
  act(() => { selectBoardTab("t2"); selectBoardTab("t1"); });
  await click(t("boardMenu.splitSubmit"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(calls).toEqual([]);
});

test("unknown outcome refreshes without repeating the step and keeps the sheet usable", async () => {
  failure = true;
  const { finished } = await open(); await click(t("boardMenu.resize")); await act(async () => { await finished; });
  await stepper(t("form.wider"));
  expect(calls).toHaveLength(1);
  expect(document.querySelector("dialog")?.textContent).toContain(t("boardMenu.done"));
  expect(document.querySelectorAll("dialog button:disabled").length).toBeLessThan(document.querySelectorAll("dialog button").length);
});

test("disconnect disables menu commands with the reason and closing the target externally retires the menu", async () => {
  const { finished } = await open();
  connected = false;
  await act(async () => setNetworkOnline(false));
  expect(rows().every(button => button.disabled)).toBe(true);
  expect(row(t("boardMenu.close"))?.querySelector(".menu-choice-detail")?.textContent).toBe(t("boardMenu.offline"));
  snapshot.panes = snapshot.panes?.filter(pane => pane.pane_id !== "p2");
  await act(async () => { replaceAgentsFromSnapshot(snapshot); await Promise.resolve(); });
  await finished;
  expect(document.querySelector("dialog")).toBeNull(); expect(calls).toEqual([]);
});

test("a maximized tab keeps sizing visible with the reason and offers restore", async () => {
  snapshot.layouts![0].zoomed = true;
  replaceAgentsFromSnapshot(snapshot); act(() => focusBoard("w1", "t1"));
  await open();
  expect(row(t("boardMenu.resize"))?.disabled).toBe(true);
  expect(row(t("boardMenu.resize"))?.querySelector(".menu-choice-detail")?.textContent).toBe(t("boardMenu.zoomedReason"));
  expect(row(t("boardMenu.restore"))?.disabled).toBe(false);
});

test("split preserves a fitted custom camera and an in-flight result cannot pull the reader back to its tab", async () => {
  act(() => setBoardCamera({ scale: 1.8, panX: -75, panY: 40 }, true));
  await splitSheet("right"); await click(t("boardMenu.splitSubmit"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(liveBoardCamera()).toMatchObject({ scale: 1.8, panX: -75, panY: 40, fitted: true });
  let release!: () => void;
  splitWait = new Promise<void>(resolve => { release = resolve; });
  await splitSheet("down"); await click(t("boardMenu.splitSubmit"));
  expect(calls).toHaveLength(2);
  await act(async () => selectBoardTab("t2"));
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(liveBoardCatalog().tabId).toBe("t2");
  expect(boardInteractionStore.get().createdPaneId).toBe("");
});
