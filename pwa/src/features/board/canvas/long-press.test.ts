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
  const release = bindBoardCanvasGestures(viewport, stage, layout, {
    readCamera: () => boardCamera(1, 0, 0, true), writeCamera: () => { calls.pans++; },
    scrollPane: () => { calls.scrolls++; return true; }, requestPanePreview: () => {}, openPane: () => {},
    openMenu: id => { calls.menus.push(id); },
  });
  releases.push(release);
  const pointer = (type: string, extra: PointerEventInit = {}, target: Element = tile) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
      pointerType: "touch", clientX: 40, clientY: 40, button: 0, ...extra }));
  return { viewport, tile, pointer, calls, release };
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

test("mouse down and the more button do not arm a long press", async () => {
  const mouse = setup(); const more = setup();
  mouse.pointer("pointerdown", { pointerType: "mouse" });
  more.pointer("pointerdown", {}, more.tile.querySelector(".board-pane-more")!);
  await wait();
  expect(mouse.calls.menus).toEqual([]); expect(more.calls.menus).toEqual([]);
  mouse.pointer("pointerup", { pointerType: "mouse" });
  expect(mouse.calls.opens).toBe(1);
});

test("a drag cannot swallow a later more-button click", () => {
  const rig = setup();
  rig.pointer("pointerdown"); rig.pointer("pointermove", { clientX: 90 }); rig.pointer("pointerup");
  const more = rig.tile.querySelector(".board-pane-more")!;
  rig.pointer("pointerdown", {}, more); rig.pointer("pointerup", {}, more);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
  more.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(false);
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
