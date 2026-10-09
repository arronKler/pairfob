import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindBoardCanvasGestures, BOARD_LONG_PRESS_MS } from "./gesture-adapter";
import { boardCamera } from "../model/camera";
import type { TabLayout } from "../../../lib/layout";

const layout: TabLayout = { workspaceId: "w1", tabId: "t1", zoomed: false, focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 80, height: 24 }, panes: [{ paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } }] };
const releases: Array<() => void> = [];
beforeEach(resetBoardTestDOM);
afterEach(() => { releases.splice(0).forEach(release => release()); for (const node of [...document.body.children]) if (node.id !== "app") node.remove(); });
const wait = () => new Promise(resolve => setTimeout(resolve, BOARD_LONG_PRESS_MS + 30));

function setup() {
  const viewport = document.createElement("div");
  const stage = document.createElement("div");
  const tile = document.createElement("div");
  tile.className = "board-pane"; tile.dataset.paneId = "p1";
  tile.innerHTML = '<button class="board-pane-open">Open</button><button class="board-pane-more">More</button>';
  viewport.append(stage); stage.append(tile); document.body.append(viewport);
  const calls = { menus: [] as string[], opens: 0, scrolls: 0, pans: 0 };
  tile.addEventListener("click", () => calls.opens++);
  // The pane's ⋯ keeps its click to itself, as the rendered button does.
  let mores = 0;
  tile.querySelector(".board-pane-more")!.addEventListener("click", (event) => { event.stopPropagation(); mores++; });
  const release = bindBoardCanvasGestures(viewport, stage, layout, {
    readCamera: () => boardCamera(1, 0, 0, true), writeCamera: () => { calls.pans++; },
    scrollPane: () => { calls.scrolls++; return true; }, requestPanePreview: () => {}, openPane: () => {},
    openMenu: id => { calls.menus.push(id); },
  });
  releases.push(release);
  const pointer = (type: string, extra: PointerEventInit = {}, target: Element = tile) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
      pointerType: "touch", clientX: 40, clientY: 40, button: 0, ...extra }));
  return { viewport, tile, pointer, calls, release, mores: () => mores };
}

test("long press opens exactly one menu; release and the native context menu do not open the pane", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await wait();
  expect(rig.calls.menus).toEqual(["p1"]);
  rig.tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  rig.pointer("pointermove", { clientX: 140 });
  rig.pointer("pointerup");
  rig.tile.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(rig.calls).toEqual({ menus: ["p1"], opens: 0, scrolls: 0, pans: 0 });
});

test("drag, second finger, cancellation, capture loss and teardown all cancel the timer", async () => {
  const rigs = Array.from({ length: 5 }, setup);
  rigs.forEach(rig => rig.pointer("pointerdown"));
  rigs[0].pointer("pointermove", { clientX: 65 });
  rigs[1].pointer("pointerdown", { pointerId: 2, clientX: 70 });
  rigs[2].pointer("pointercancel");
  rigs[3].pointer("lostpointercapture");
  rigs[4].release();
  await wait();
  for (const rig of rigs) {
    rig.pointer("pointerup"); rig.pointer("pointerup", { pointerId: 2 });
    expect(rig.calls.menus).toEqual([]);
    expect(rig.calls.opens).toBe(0);
  }
});

test("a native touch context menu before the timer cancels the timer and release tap", async () => {
  const rig = setup(); rig.pointer("pointerdown");
  rig.tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  await wait(); rig.pointer("pointerup");
  expect(rig.calls.menus).toEqual(["p1"]); expect(rig.calls.opens).toBe(0);
});

test("short taps synthesize one click and suppress the following native click; keyboard activation still works", () => {
  const rig = setup(); rig.pointer("pointerdown"); rig.pointer("pointerup");
  rig.tile.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(rig.calls.opens).toBe(1);
  rig.tile.querySelector<HTMLButtonElement>(".board-pane-open")!.click();
  expect(rig.calls.opens).toBe(2);
});

test("a mouse button held down does not arm a long press; a finger held on the ⋯ is a hold on its pane", async () => {
  const mouse = setup(); const more = setup();
  mouse.pointer("pointerdown", { pointerType: "mouse" });
  more.pointer("pointerdown", {}, more.tile.querySelector(".board-pane-more")!);
  await wait();
  expect(mouse.calls.menus).toEqual([]);
  // One pane, nothing to swap with: the hold is the menu, as anywhere else on the pane.
  expect(more.calls.menus).toEqual(["p1"]);
  more.pointer("pointerup", {}, more.tile.querySelector(".board-pane-more")!);
  expect(more.mores()).toBe(0);
  expect(more.calls.menus).toEqual(["p1"]);
  mouse.pointer("pointerup", { pointerType: "mouse" });
  expect(mouse.calls.opens).toBe(1);
});

test("a tap on the ⋯ is the ⋯'s own click, once, after a drag as well", () => {
  const rig = setup();
  rig.pointer("pointerdown"); rig.pointer("pointermove", { clientX: 90 }); rig.pointer("pointerup");
  const more = rig.tile.querySelector(".board-pane-more")!;
  rig.pointer("pointerdown", {}, more); rig.pointer("pointerup", {}, more);
  expect(rig.mores()).toBe(1);
  // The browser's own click for that release is the same tap, not a second one.
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
  more.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(rig.mores()).toBe(1);
  // The keyboard still presses it.
  (more as HTMLButtonElement).click();
  expect(rig.mores()).toBe(2);
  expect(rig.calls.opens).toBe(0);
});

test("a drag that starts on the ⋯ is the pane's: sideways pans, vertical scrolls, a second finger pinches", () => {
  const sideways = setup();
  const more = (rig: ReturnType<typeof setup>) => rig.tile.querySelector(".board-pane-more")!;
  sideways.pointer("pointerdown", {}, more(sideways));
  sideways.pointer("pointermove", { clientX: 100 }, sideways.viewport);
  sideways.pointer("pointerup", { clientX: 100 }, sideways.viewport);
  expect(sideways.calls).toMatchObject({ pans: 1, scrolls: 0 });
  expect(sideways.mores()).toBe(0);

  const vertical = setup();
  vertical.pointer("pointerdown", {}, more(vertical));
  vertical.pointer("pointermove", { clientY: 100 }, vertical.viewport);
  vertical.pointer("pointerup", { clientY: 100 }, vertical.viewport);
  expect(vertical.calls).toMatchObject({ pans: 0, scrolls: 1 });
  expect(vertical.mores()).toBe(0);

  const pinch = setup();
  pinch.pointer("pointerdown", {}, more(pinch));
  pinch.pointer("pointerdown", { pointerId: 2, isPrimary: false, clientX: 140 });
  pinch.pointer("pointermove", { clientX: 20 }, pinch.viewport);
  pinch.pointer("pointermove", { pointerId: 2, isPrimary: false, clientX: 180 }, pinch.viewport);
  pinch.pointer("pointerup", { pointerId: 2, isPrimary: false, clientX: 180 }, pinch.viewport);
  pinch.pointer("pointerup", { clientX: 20 }, pinch.viewport);
  expect(pinch.calls.pans).toBe(1);
  expect(pinch.mores()).toBe(0);
  expect(pinch.calls.opens).toBe(0);
});

test("long press menu does not swallow the subsequent split placement tap", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await wait();
  rig.pointer("pointerup");
  expect(rig.calls.menus).toEqual(["p1"]);

  const ghost = document.createElement("button");
  ghost.dataset.boardOverlay = "";
  rig.viewport.append(ghost);
  let picks = 0;
  ghost.addEventListener("click", () => picks++);
  rig.pointer("pointerdown", {}, ghost);
  rig.pointer("pointerup", {}, ghost);
  ghost.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(picks).toBe(1);
  expect(rig.calls.opens).toBe(0);
});

/** The touch end the browser sends after pointerup; whether it stays uncancelled decides the tap's click. */
function touchEnd(target: Element): boolean {
  const event = new TouchEvent("touchend", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

test("the release of a held press cannot tap the menu it opened, and the next press starts clean", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await wait();
  rig.pointer("pointerup");
  expect(rig.calls.menus).toEqual(["p1"]);
  // Cancelled at its source: the click would land on the dialog, where the canvas cannot stop it.
  expect(touchEnd(rig.tile)).toBe(true);

  // The canvas keeps nothing armed: the next tap, on the ⋯ or on the pane, keeps its touch end.
  const more = rig.tile.querySelector(".board-pane-more")!;
  rig.pointer("pointerdown", {}, more); rig.pointer("pointerup", {}, more);
  expect(touchEnd(more)).toBe(false);
  expect(rig.mores()).toBe(1);
  rig.pointer("pointerdown"); rig.pointer("pointerup");
  expect(rig.calls.opens).toBe(1);
});

test("a tap, a drag and presses the canvas leaves to a control keep their native touch end", async () => {
  const tap = setup(); tap.pointer("pointerdown"); tap.pointer("pointerup");
  expect(touchEnd(tap.tile)).toBe(false);

  const drag = setup();
  drag.pointer("pointerdown"); drag.pointer("pointermove", { clientX: 90 }); drag.pointer("pointerup");
  expect(touchEnd(drag.tile)).toBe(false);

  const overlay = setup();
  const ghost = document.createElement("button");
  ghost.dataset.boardOverlay = "";
  overlay.viewport.append(ghost);
  overlay.pointer("pointerdown", {}, ghost); overlay.pointer("pointerup", {}, ghost);
  expect(touchEnd(ghost)).toBe(false);

  const gone = setup(); gone.pointer("pointerdown");
  await wait();
  gone.release();
  expect(touchEnd(gone.tile)).toBe(false);
});

test("a touch end the browser will not let go of is left as it is", async () => {
  const rig = setup();
  rig.pointer("pointerdown");
  await wait();
  rig.pointer("pointerup");
  const event = new TouchEvent("touchend", { bubbles: true, cancelable: false });
  rig.tile.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
