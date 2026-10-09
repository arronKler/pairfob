import { happy, resetChatDOM } from "../../../test-support/chat-dom";
import { expectSameNode } from "../../../test-support/node-identity";
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
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { noticesStore } from "../../app/notices-store";

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

/** A desk-sized window with the page's gesture memory bound, as the app runs it. */
async function onDesk(run: (more: HTMLButtonElement, tile: HTMLElement) => Promise<void>) {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  const release = bindOverlayOrigin(document);
  const tile = document.querySelector<HTMLElement>('.board-pane[data-pane-id="p2"]')!;
  const more = tile.querySelector<HTMLButtonElement>(".board-pane-more")!;
  // A test DOM lays nothing out, so the pane's ⋯ is told where it stands. A
  // reconnect draws the tile again, and the ⋯ drawn in its place stands there
  // too: an open menu follows its trigger to the new element only when that
  // one has a box, and closes when it has none (`popover-frame`).
  const stand = () => {
    for (const drawn of document.querySelectorAll<HTMLElement>('.board-pane[data-pane-id="p2"] .board-pane-more')) {
      drawn.getBoundingClientRect = () => ({ left: 700, top: 120, right: 728, bottom: 144, width: 28, height: 24, x: 700, y: 120, toJSON() {} });
    }
  };
  stand();
  const redrawn = new MutationObserver(stand);
  redrawn.observe(document.body, { childList: true, subtree: true });
  try { await run(more, tile); } finally {
    redrawn.disconnect();
    await settle(); release();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
}
/** Close what is open and let the menu's own teardown publish inside act. */
async function settle() {
  await act(async () => { closeTestDialogs(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
function press(target: Element, pointerType: string, init: Record<string, unknown> = {}) {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 714, clientY: 132, ...init }) as unknown as Event);
}
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.board-pane-sheet")!;

test("a mouse on the tile's ⋯ gets the whole menu anchored under it; its sub-flows keep their own sheet", async () => {
  await onDesk(async (more) => {
    press(more, "mouse");
    const { finished } = await open();
    expect(sheet().className).toBe("modal sheet popover popover-menu board-pane-sheet");
    expect([sheet().style.left, sheet().style.top]).toEqual(["700px", "150px"]);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(sheet().querySelector(".sheet-body")?.getAttribute("role")).toBe("menu");
    expect([...sheet().querySelectorAll("[role=group]")].map(node => node.getAttribute("aria-label")))
      .toEqual([t("boardMenu.groupPane"), t("boardMenu.groupLayout"), t("boardMenu.groupManage")]);
    expect([...sheet().querySelectorAll("[role=menuitem]")].map(node => node.querySelector(".menu-choice-title")?.textContent)).toEqual([
      t("boardMenu.open"), t("boardMenu.rename"), t("boardMenu.split"), t("boardMenu.resize"), t("boardMenu.swapPick"),
      t("boardMenu.maximize"), t("boardMenu.close"),
    ]);
    await click(t("boardMenu.resize")); await act(async () => { await finished; });
    expect(more.hasAttribute("aria-expanded")).toBe(false);
    const resize = document.querySelector<HTMLDialogElement>("dialog.board-resize-sheet")!;
    expect(resize.open).toBe(true);
    expect(resize.hasAttribute("data-popover")).toBe(false);
  });
});

test("a context click opens the menu at the pointer, and the keyboard under the ⋯", async () => {
  await onDesk(async (more, tile) => {
    press(tile.querySelector(".board-pane-open")!, "mouse", { button: 2, clientX: 520, clientY: 310 });
    await open();
    expect([sheet().style.left, sheet().style.top]).toEqual(["520px", "310px"]);
    await settle();
    // The tile's own menu key, through the canvas controller.
    await act(async () => {
      tile.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }) as unknown as Event);
      await Promise.resolve();
    });
    expect(sheet().dataset.popover).toBe("menu");
    expect([sheet().style.left, sheet().style.top]).toEqual(["700px", "150px"]);
  });
});

test("the window crossed a tier under the open menu: closing returns focus to the same control on the redrawn board", async () => {
  await onDesk(async (more, tile) => {
    press(more, "mouse");
    const { finished } = await open();
    // Crossing a tier draws the shell again: the board is mounted anew under the open menu.
    await act(async () => { unmountApp(); mountApp(); commitView(); await Promise.resolve(); });
    expect(tile.isConnected).toBe(false);
    expect(sheet().open).toBe(true);
    await settle();
    await act(async () => { await finished; });
    const again = document.querySelector<HTMLElement>('.board-pane[data-pane-id="p2"]')!;
    expectSameNode(document.activeElement, again.querySelector(".board-pane-more"));
  });
});

test("the menu gives focus back to what opened it: the ⋯ for a press or a key on it, the pane for a context click", async () => {
  await onDesk(async (more, tile) => {
    const openButton = tile.querySelector<HTMLButtonElement>(".board-pane-open")!;
    const closed = async (finished: Promise<void>) => { await settle(); await act(async () => { await finished; }); };
    // A mouse on the ⋯. Not every engine focuses a clicked button, so nothing here focused it first.
    press(more, "mouse");
    await closed((await open()).finished);
    expectSameNode(document.activeElement, more);
    // The keyboard: Tab reached the ⋯ and Enter opened it.
    act(() => openButton.focus());
    act(() => more.focus());
    more.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    await closed((await open()).finished);
    expectSameNode(document.activeElement, more);
    // A context click on the pane belongs to the pane, even while the ⋯ still holds focus.
    press(openButton, "mouse", { button: 2, clientX: 520, clientY: 310 });
    await closed((await open()).finished);
    expectSameNode(document.activeElement, openButton);
  });
});

test("a dialog opened from the menu returns to the ⋯ too, whichever way it is closed", async () => {
  await onDesk(async (more) => {
    for (const leave of ["cancel", "close"] as const) {
      press(more, "mouse");
      const { finished } = await open();
      await click(t("boardMenu.rename"));
      const rename = document.querySelector<HTMLDialogElement>("dialog[open]:not(.board-pane-sheet)")!;
      expect(rename).not.toBeNull();
      await act(async () => {
        if (leave === "cancel") [...rename.querySelectorAll("button")].find(button => button.textContent?.trim() === t("cancel"))!.click();
        else rename.querySelector<HTMLButtonElement>(".desk-close")!.click();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      await act(async () => { await finished; });
      expect(document.querySelector("dialog[open]")).toBeNull();
      expectSameNode(document.activeElement, more);
    }
    expect(calls).toEqual([]);
  });
});

test("a finger's menu stays with the pane: closing it leaves focus on the pane's open button, as before", async () => {
  await onDesk(async (more, tile) => {
    press(more, "touch");
    const { finished } = await open();
    await settle(); await act(async () => { await finished; });
    expectSameNode(document.activeElement, tile.querySelector(".board-pane-open"));
  });
});

test("picking where a split goes takes focus off the ghost before it leaves: the split form closes back onto the ⋯", async () => {
  await onDesk(async (more) => {
    press(more, "mouse");
    const { finished } = await open();
    await click(t("boardMenu.split")); await act(async () => { await finished; });
    expectSameNode(document.activeElement, more);
    const ghost = document.querySelector<HTMLButtonElement>(".board-place-ghost")!;
    // A click focuses the ghost, and the ghost is gone the moment it is picked.
    await act(async () => { ghost.focus(); ghost.click(); await Promise.resolve(); });
    expect(ghost.isConnected).toBe(false);
    expect(document.querySelector<HTMLDialogElement>("dialog.board-split-sheet")?.open).toBe(true);
    await settle();
    expectSameNode(document.activeElement, more);
    // Cancel in the tab row, focused by a click, hands focus back the same way.
    press(more, "mouse");
    const second = await open();
    await click(t("boardMenu.swapPick")); await act(async () => { await second.finished; });
    const cancel = document.querySelector<HTMLButtonElement>(".board-place-banner .board-mode-cancel")!;
    await act(async () => { cancel.focus(); cancel.click(); await Promise.resolve(); });
    expect(boardInteractionStore.get().placementKind).toBe("");
    expectSameNode(document.activeElement, more);
  });
});

test("the notice says which way the zoom went", async () => {
  const notice = () => noticesStore.get().notice?.text;
  const { finished } = await open();
  await click(t("boardMenu.maximize")); await act(async () => { await finished; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(calls.at(-1)).toEqual({ method: "zoom", value: { pane_id: "p2", mode: "on" } });
  expect(notice()).toBe(t("op.zoomed"));
  snapshot.layouts![0].zoomed = true;
  replaceAgentsFromSnapshot(snapshot); act(() => focusBoard("w1", "t1"));
  const again = await open();
  await click(t("boardMenu.restore")); await act(async () => { await again.finished; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(calls.at(-1)).toEqual({ method: "zoom", value: { pane_id: "p2", mode: "off" } });
  expect(notice()).toBe(t("op.unzoomed"));
  expect(t("op.unzoomed")).not.toBe(t("op.zoomed"));
});

test("a finger on the same wide board keeps the sheet", async () => {
  await onDesk(async (more) => {
    press(more, "touch");
    await open();
    expect(sheet().className).toBe("modal sheet board-pane-sheet");
    expect(sheet().hasAttribute("data-popover")).toBe(false);
    expect(sheet().querySelectorAll("[role=menuitem], [role=group], [role=menu]")).toHaveLength(0);
    expect(sheet().querySelector(".sheet-subtitle")?.textContent).toContain(t("boardMenu.positionH", { h: t("boardMenu.h.right") }));
    expect(more.hasAttribute("aria-expanded")).toBe(false);
  });
});

test("a finger-opened menu rings no row until a key is pressed; a mouse keeps the ring from the start", async () => {
  await onDesk(async (more) => {
    // The shared dialog lifecycle marks the dialog; the board menu opens through it like any sheet.
    const quiet = () => sheet().hasAttribute("data-quiet-focus");
    // A long press has no click of its own, so the browser would ring the row the sheet focuses.
    press(more, "touch");
    await open();
    expect(quiet()).toBe(true);
    // A press inside the open sheet is not a key.
    press(row(t("boardMenu.rename"))!, "touch");
    expect(quiet()).toBe(true);
    await act(async () => {
      sheet().dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }) as unknown as Event);
      await Promise.resolve();
    });
    expect(quiet()).toBe(false);
    await settle();

    press(more, "mouse");
    await open();
    expect(quiet()).toBe(false);
  });
});

const swapDetail = () => row(t("boardMenu.swapPick"))?.querySelector(".menu-choice-detail")?.textContent;

test("the swap row names the shortcut of whoever opened the menu: the keys for a mouse or the keyboard, the lift for a finger", async () => {
  await onDesk(async (more) => {
    // A reconnect redraws the tiles, so each step presses the one on screen.
    const tile = () => document.querySelector<HTMLElement>('.board-pane[data-pane-id="p2"]')!;
    press(more, "mouse");
    await open();
    expect(swapDetail()).toBe(t("boardMenu.swapDetailKeys"));
    // A press inside the open menu does not change who opened it, however often the menu re-reads.
    press(row(t("boardMenu.rename"))!, "touch");
    await act(async () => { setNetworkOnline(false); await Promise.resolve(); });
    expect(row(t("boardMenu.swapPick"))?.disabled).toBe(true);
    await act(async () => { setNetworkOnline(true); await Promise.resolve(); });
    expect(swapDetail()).toBe(t("boardMenu.swapDetailKeys"));
    await settle();

    await act(async () => {
      tile().dispatchEvent(new happy.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }) as unknown as Event);
      await Promise.resolve();
    });
    expect(swapDetail()).toBe(t("boardMenu.swapDetailKeys"));
    await settle();

    press(tile().querySelector(".board-pane-more")!, "touch");
    await open();
    expect(swapDetail()).toBe(t("boardMenu.swapDetail"));
  });
});

test("a mouse on a narrow board is told the keys too, and a page that remembers no gesture keeps the finger's hint", async () => {
  await open();
  expect(swapDetail()).toBe(t("boardMenu.swapDetail"));
  await settle();
  const release = bindOverlayOrigin(document);
  try {
    press(document.querySelector('.board-pane[data-pane-id="p2"] .board-pane-more')!, "mouse");
    await open();
    expect(sheet().hasAttribute("data-popover")).toBe(false);
    expect(swapDetail()).toBe(t("boardMenu.swapDetailKeys"));
  } finally { await settle(); release(); }
});
