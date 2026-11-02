import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import type { LayoutDirection } from "../../../lib/operations";
import { boardCamera, type BoardCamera } from "../model/camera";
import { bindBoardCanvasGestures, BOARD_LONG_PRESS_MS } from "./gesture-adapter";
import { startLift } from "./lift-swap";

// p1 | p2, side by side; tile rects are stubbed because the test DOM has no layout.
const layout: TabLayout = { workspaceId: "w1", tabId: "t1", zoomed: false, focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 100, height: 40 }, panes: [
    { paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } },
    { paneId: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } },
  ] };
const releases: Array<() => void> = [];
beforeEach(() => { resetBoardTestDOM(); jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); releases.splice(0).forEach(release => release()); for (const node of [...document.body.children]) if (node.id !== "app") node.remove(); });
/** Advance the fake clock and flush the microtasks a settle or a watch runs on. */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
const hold = () => advance(BOARD_LONG_PRESS_MS + 30);

function rect(left: number, width: number) {
  return () => ({ left, top: 0, right: left + width, bottom: 100, width, height: 100, x: left, y: 0, toJSON() {} }) as DOMRect;
}

function setup(options: { swap?: boolean; reason?: string } = {}) {
  const viewport = document.createElement("div");
  const stage = document.createElement("div");
  const tiles = ["p1", "p2"].map((id, index) => {
    const tile = document.createElement("div");
    tile.className = "board-pane";
    tile.dataset.paneId = id;
    tile.getBoundingClientRect = rect(index * 100, 100);
    stage.append(tile);
    return tile;
  });
  const handle = document.createElement("div");
  handle.dataset.boardOverlay = "";
  stage.append(handle);
  viewport.append(stage);
  document.body.append(viewport);
  const calls = { menus: [] as string[], swaps: [] as Array<[string, LayoutDirection]>, cameras: [] as BoardCamera[], opens: 0 };
  tiles.forEach(tile => tile.addEventListener("click", () => calls.opens++));
  let camera = boardCamera(1, 0, 0, true);
  releases.push(bindBoardCanvasGestures(viewport, stage, layout, {
    readCamera: () => camera,
    writeCamera: next => { camera = next; calls.cameras.push(next); },
    scrollPane: () => true, requestPanePreview: () => {}, openPane: () => {},
    openMenu: id => { calls.menus.push(id); },
    ...(options.swap === false ? {} : { commitSwap: (id: string, direction: LayoutDirection) => { calls.swaps.push([id, direction]); } }),
    swapReason: () => options.reason ?? "",
  }));
  const pointer = (type: string, extra: PointerEventInit = {}, target: Element = tiles[0]) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
      pointerType: "touch", clientX: 40, clientY: 40, button: 0, ...extra }));
  return { viewport, tiles, handle, pointer, calls };
}

test("a long press lifts the tile and marks only the panes it can swap with", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await hold();
  expect(rig.tiles[0].dataset.boardLift).toBe("");
  expect(rig.tiles[1].dataset.boardDrop).toBe("right");
  expect(rig.tiles[1].dataset.boardDropLabel).toBeTruthy();
  expect(rig.calls.menus).toEqual([]);
});

test("releasing a lifted tile in place opens the menu and clears every mark", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await hold();
  rig.pointer("pointerup");
  rig.tiles[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(rig.calls).toMatchObject({ menus: ["p1"], swaps: [], opens: 0 });
  for (const tile of rig.tiles) expect(Object.keys(tile.dataset).filter(key => key.startsWith("board"))).toEqual([]);
});

test("dropping a lifted tile on a neighbour swaps toward it; elsewhere it falls back", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await hold();
  rig.pointer("pointermove", { clientX: 150 });
  // Dragged: a release is no longer the menu, and the tab row's hint follows this mark.
  expect(rig.tiles[0].dataset.boardLift).toBe("moved");
  expect(rig.tiles[1].dataset.boardDropOver).toBe("");
  expect(rig.tiles[0].style.getPropertyValue("--board-lift-x")).toBe("110px");
  rig.pointer("pointerup", { clientX: 150 });
  expect(rig.calls).toMatchObject({ menus: [], swaps: [["p1", "right"]], opens: 0 });

  const miss = setup();
  miss.pointer("pointerdown");
  await hold();
  miss.pointer("pointermove", { clientX: 40, clientY: 400 });
  miss.pointer("pointerup", { clientX: 40, clientY: 400 });
  expect(miss.calls).toMatchObject({ menus: [], swaps: [] });
  expect(miss.tiles[0].dataset.boardLift).toBeUndefined();
});

test("a lifted tile's release never taps: not the menu it opens in place, not the pane it is dropped on", async () => {
  const touchEnd = (target: Element) => {
    const event = new TouchEvent("touchend", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const inPlace = setup();
  inPlace.pointer("pointerdown");
  await hold();
  inPlace.pointer("pointerup");
  expect(inPlace.calls.menus).toEqual(["p1"]);
  expect(touchEnd(inPlace.tiles[0])).toBe(true);

  const dropped = setup();
  dropped.pointer("pointerdown");
  await hold();
  dropped.pointer("pointermove", { clientX: 150 });
  dropped.pointer("pointerup", { clientX: 150 });
  expect(touchEnd(dropped.tiles[0])).toBe(true);
  expect(dropped.calls).toMatchObject({ menus: [], swaps: [["p1", "right"]], opens: 0 });
});

test("without a swap port, or while swapping is refused, a long press is the menu as before", async () => {
  for (const rig of [setup({ swap: false }), setup({ reason: "offline" })]) {
    rig.pointer("pointerdown");
    await hold();
    expect(rig.calls.menus).toEqual(["p1"]);
    expect(rig.tiles[0].dataset.boardLift).toBeUndefined();
  }
});

test("a second finger or a cancel drops the lift without swapping or opening", async () => {
  const two = setup();
  two.pointer("pointerdown");
  await hold();
  two.pointer("pointerdown", { pointerId: 2, clientX: 150 });
  two.pointer("pointerup", { clientX: 150 });
  two.pointer("pointerup", { pointerId: 2, clientX: 150 });
  expect(two.calls).toMatchObject({ menus: [], swaps: [] });
  expect(two.tiles[0].dataset.boardLift).toBeUndefined();

  const cancelled = setup();
  cancelled.pointer("pointerdown");
  await hold();
  cancelled.pointer("pointercancel");
  expect(cancelled.tiles[1].dataset.boardDrop).toBeUndefined();
});

test("a press on an overlay control is left to it: no pan, no tap, no long press", async () => {
  const rig = setup();
  rig.pointer("pointerdown", {}, rig.handle);
  rig.pointer("pointermove", { clientX: 140 }, rig.handle);
  await hold();
  rig.pointer("pointerup", { clientX: 140 }, rig.handle);
  expect(rig.calls).toMatchObject({ menus: [], swaps: [], cameras: [], opens: 0 });
});

test("camera keys: 0 fits, Ctrl/⌘ plus and minus zoom around the centre", () => {
  const rig = setup();
  const key = (init: KeyboardEventInit) => rig.viewport.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  key({ key: "0" });
  expect(rig.calls.cameras.at(-1)?.fitted).toBeTrue();
  const fitted = rig.calls.cameras.at(-1)!.scale;
  key({ key: "=", ctrlKey: true });
  expect(rig.calls.cameras.at(-1)!.scale).toBeGreaterThan(fitted);
  key({ key: "-", metaKey: true });
  expect(rig.calls.cameras.at(-1)!.scale).toBeCloseTo(fitted, 6);
  const before = rig.calls.cameras.length;
  key({ key: "0", altKey: true });
  key({ key: "v" });
  expect(rig.calls.cameras.length).toBe(before);
});

test("a carried tile is put down, not dropped: its lift marks go at once and it stays on top until it is back", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await hold();
  rig.pointer("pointermove", { clientX: 40, clientY: 400 });
  rig.pointer("pointerup", { clientX: 40, clientY: 400 });
  // The marks that held it at the finger are gone, so the stylesheet eases it home.
  expect(rig.tiles[0].dataset.boardLift).toBeUndefined();
  expect(rig.tiles[0].style.getPropertyValue("--board-lift-x")).toBe("");
  expect(rig.tiles[0].style.getPropertyValue("--board-lift-y")).toBe("");
  expect(rig.tiles[0].dataset.boardSettle).toBe("");
  expect(Object.keys(rig.tiles[1].dataset).filter(key => key.startsWith("board"))).toEqual([]);
  await advance(300);
  expect(rig.tiles[0].dataset.boardSettle).toBeUndefined();
});

test("a tile picked up again on its way back is only lifted", () => {
  const root = document.createElement("div");
  const tile = document.createElement("div");
  tile.className = "board-pane";
  tile.dataset.paneId = "p1";
  root.append(tile);
  document.body.append(root);
  const carry = startLift(root, tile, "p1", new Map(), { x: 0, y: 0 }, 8);
  carry.move({ x: 30, y: 0 });
  carry.cancel();
  expect(tile.dataset.boardSettle).toBe("");
  const again = startLift(root, tile, "p1", new Map(), { x: 0, y: 0 }, 8);
  expect(tile.dataset.boardLift).toBe("");
  expect(tile.dataset.boardSettle).toBeUndefined();
  // Held in place and let go: it never left, so there is no way back to mark.
  again.finish();
  expect(Object.keys(tile.dataset).filter(key => key.startsWith("board"))).toEqual([]);
});

function carryOnto(direction: LayoutDirection = "right") {
  const root = document.createElement("div");
  const [tile, other] = ["p1", "p2"].map((id, index) => {
    const node = document.createElement("div");
    node.className = "board-pane";
    node.dataset.paneId = id;
    node.style.left = `${index * 100}px`;
    node.getBoundingClientRect = rect(index * 100, 100);
    root.append(node);
    return node;
  });
  document.body.append(root);
  const carry = startLift(root, tile, "p1", new Map([["p2", direction]]), { x: 40, y: 40 }, 8);
  carry.move({ x: 150, y: 40 });
  return { root, tile, other, carry };
}

test("a tile dropped on a neighbour is held at the finger until its box changes, then put down in the same turn", async () => {
  const { tile, other, carry } = carryOnto();
  const result = carry.finish();
  expect([result.target, result.direction]).toEqual(["p2", "right"]);
  // Let go, but not put down: the offset stays and the lift marks are gone.
  expect(tile.dataset.boardLift).toBeUndefined();
  expect(tile.dataset.boardSettle).toBe("held");
  expect(tile.style.getPropertyValue("--board-lift-x")).toBe("110px");
  expect(Object.keys(other.dataset).filter(key => key.startsWith("board"))).toEqual([]);
  // A repaint that writes the same box is not the layout answering.
  tile.style.left = "0px";
  await Promise.resolve();
  expect(tile.dataset.boardSettle).toBe("held");
  // The new box: the offset leaves with it, and the tile only has to stay on top.
  tile.style.left = "100px";
  await advance(0);
  expect(tile.style.getPropertyValue("--board-lift-x")).toBe("");
  expect(tile.dataset.boardSettle).toBe("");
  // The request ending afterwards has nothing left to put down.
  result.putDown();
  expect(tile.dataset.boardSettle).toBe("");
  await advance(300);
  expect(tile.dataset.boardSettle).toBeUndefined();
});

test("a swap that ends without a new box puts the held tile back, and picking it up again ends the hold", () => {
  const { tile, carry } = carryOnto();
  const result = carry.finish();
  expect(tile.dataset.boardSettle).toBe("held");
  result.putDown();
  expect(tile.style.getPropertyValue("--board-lift-x")).toBe("");
  expect(tile.dataset.boardSettle).toBe("");

  const again = carryOnto("left");
  again.carry.finish();
  expect(again.tile.dataset.boardSettle).toBe("held");
  startLift(again.root, again.tile, "p1", new Map(), { x: 0, y: 0 }, 8);
  expect(again.tile.dataset.boardSettle).toBeUndefined();
  expect(again.tile.dataset.boardLift).toBe("");
});

test("the gesture puts the tile down when the swap it asked for is over", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await hold();
  rig.pointer("pointermove", { clientX: 150, clientY: 40 });
  rig.pointer("pointerup", { clientX: 150, clientY: 40 });
  expect(rig.calls.swaps).toEqual([["p1", "right"]]);
  expect(rig.tiles[0].dataset.boardSettle).toBe("held");
  await advance(0);
  expect(rig.tiles[0].dataset.boardSettle).toBe("");
});
