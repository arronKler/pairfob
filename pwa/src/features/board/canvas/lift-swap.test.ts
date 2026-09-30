import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import type { LayoutDirection } from "../../../lib/operations";
import { boardCamera, type BoardCamera } from "../model/camera";
import { bindBoardCanvasGestures, BOARD_LONG_PRESS_MS } from "./gesture-adapter";

// p1 | p2, side by side; tile rects are stubbed because the test DOM has no layout.
const layout: TabLayout = { workspaceId: "w1", tabId: "t1", zoomed: false, focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 100, height: 40 }, panes: [
    { paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } },
    { paneId: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } },
  ] };
const releases: Array<() => void> = [];
beforeEach(resetBoardTestDOM);
afterEach(() => { releases.splice(0).forEach(release => release()); for (const node of [...document.body.children]) if (node.id !== "app") node.remove(); });
const hold = () => new Promise(resolve => setTimeout(resolve, BOARD_LONG_PRESS_MS + 30));

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
