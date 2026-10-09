import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import { bindBoardCanvasGestures } from "./gesture-adapter";
import { boardCamera, fitCamera, type BoardCamera } from "../model/camera";

/**
 * A vertical drag that starts on a pane. A finger scrolls that pane on the
 * computer whatever the zoom, because two fingers move the board. A mouse has
 * one pointer: on a board that fits it scrolls the pane too, and on a board
 * that reaches past its window above or below it moves the board, as its wheel
 * does first. The stage here is measurable (800×640).
 */
const layout: TabLayout = {
  workspaceId: "w1",
  tabId: "w1:t1",
  zoomed: false,
  focusedPaneId: "w1:p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};
const STAGE = { width: 800, height: 640 };
const VIEW = { width: 800, height: 600 };

beforeEach(resetBoardTestDOM);
afterEach(() => {
  for (const node of [...document.body.children]) if (node.id !== "app") node.remove();
});

function board(camera: BoardCamera, view = VIEW) {
  const viewport = document.createElement("div");
  const stage = document.createElement("div");
  stage.style.width = `${STAGE.width}px`;
  stage.style.height = `${STAGE.height}px`;
  const tile = document.createElement("button");
  tile.className = "board-pane";
  tile.dataset.paneId = "w1:p1";
  stage.append(tile);
  viewport.append(stage);
  document.body.append(viewport);
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: view.width });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: view.height });
  let current = camera;
  const scrolls: string[] = [];
  const stop = bindBoardCanvasGestures(viewport, stage, layout, {
    readCamera: () => current,
    writeCamera: (next) => { current = next; },
    scrollPane: (_layout, paneId, direction, lines) => { scrolls.push(`${paneId} ${direction} ${lines}`); return true; },
    requestPanePreview: () => {},
    openPane: () => {},
  });
  const pointer = (pointerType: string, target: Element, type: string, x: number, y: number, pointerId = 1): void => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, isPrimary: pointerId === 1, pointerType, clientX: x, clientY: y, button: 0,
    }));
  };
  /** One pointer down on the pane, along `path`, and up. */
  const drag = (pointerType: string, path: Array<[number, number]>): void => {
    const [[x0, y0], ...rest] = path;
    pointer(pointerType, tile, "pointerdown", x0, y0);
    for (const [x, y] of rest) pointer(pointerType, viewport, "pointermove", x, y);
    const [x1, y1] = path[path.length - 1];
    pointer(pointerType, viewport, "pointerup", x1, y1);
  };
  return { viewport, tile, stop, drag, pointer, scrolls, camera: () => current };
}

/** 1280px tall in a 600px window, 100px of it above; 1600px wide in 800px, 300px to the left. */
const zoomed = () => boardCamera(2, -300, -100, true);

describe("a vertical mouse drag that starts on a pane", () => {
  test("on a board that fits it scrolls the pane and leaves the board where it is", () => {
    const fit = fitCamera(VIEW.width, VIEW.height, STAGE);
    const { stop, drag, scrolls, camera } = board(fit);
    drag("mouse", [[400, 300], [401, 240], [401, 200]]);
    expect(scrolls).toEqual(["w1:p1 down 3", "w1:p1 down 2"]);
    expect(camera()).toBe(fit);
    stop();
  });

  test("on a board that overflows its window vertically it moves the board, and scrolls nothing", () => {
    const { stop, drag, scrolls, camera } = board(zoomed());
    drag("mouse", [[400, 300], [401, 240], [401, 200]]);
    expect(camera()).toEqual({ scale: 2, panX: -299, panY: -200, fitted: true });
    expect(scrolls).toEqual([]);
    stop();
  });

  test("the board stops at its edge and the drag does not go on into the pane", () => {
    const { stop, drag, scrolls, camera } = board(zoomed());
    // 580px of the board lie below; the pointer travels 900.
    drag("mouse", [[400, 550], [400, 500], [400, 100], [400, -350]]);
    expect(camera().panY).toBe(600 - 1280);
    // And back down to the top edge, 680px away, with 900 again.
    drag("mouse", [[400, 50], [400, 100], [400, 500], [400, 950]]);
    expect(camera().panY).toBe(0);
    expect(scrolls).toEqual([]);
    stop();
  });

  test("a board that overflows only sideways still scrolls the pane", () => {
    // 1000×800 on screen in a window 600 wide and 900 tall: wider than the window, shorter than it.
    const { stop, drag, scrolls, camera } = board(boardCamera(1.25, -100, 50, true), { width: 600, height: 900 });
    const before = camera();
    drag("mouse", [[300, 400], [300, 340]]);
    expect(scrolls).toEqual(["w1:p1 down 3"]);
    expect(camera()).toBe(before);
    stop();
  });

  test("sideways and diagonal drags move the zoomed board as they did", () => {
    const { stop, drag, scrolls, camera } = board(zoomed());
    drag("mouse", [[400, 300], [340, 302]]);
    expect(camera()).toEqual({ scale: 2, panX: -360, panY: -98, fitted: true });
    drag("mouse", [[400, 300], [450, 270]]);
    expect(camera()).toEqual({ scale: 2, panX: -310, panY: -128, fitted: true });
    expect(scrolls).toEqual([]);
    stop();
  });
});

describe("touch is unchanged on a board zoomed past its window", () => {
  test("one finger dragged vertically on a pane scrolls that pane, and the board stays", () => {
    const start = zoomed();
    const { stop, drag, scrolls, camera } = board(start);
    drag("touch", [[400, 300], [401, 240], [401, 200]]);
    expect(scrolls).toEqual(["w1:p1 down 3", "w1:p1 down 2"]);
    expect(camera()).toBe(start);
    stop();
  });

  test("a pen keeps the finger's rule", () => {
    const start = zoomed();
    const { stop, drag, scrolls, camera } = board(start);
    drag("pen", [[400, 300], [400, 240]]);
    expect(scrolls).toEqual(["w1:p1 down 3"]);
    expect(camera()).toBe(start);
    stop();
  });

  test("two fingers dragged vertically move the board, and scroll nothing", () => {
    const { viewport, tile, stop, pointer, scrolls, camera } = board(zoomed());
    pointer("touch", tile, "pointerdown", 350, 300, 1);
    pointer("touch", tile, "pointerdown", 450, 300, 2);
    for (let step = 1; step <= 4; step++) {
      pointer("touch", viewport, "pointermove", 350, 300 - step * 25, 1);
      pointer("touch", viewport, "pointermove", 450, 300 - step * 25, 2);
    }
    pointer("touch", viewport, "pointerup", 450, 200, 2);
    pointer("touch", viewport, "pointerup", 350, 200, 1);
    expect(camera()).toEqual({ scale: 2, panX: -300, panY: -200, fitted: true });
    expect(scrolls).toEqual([]);
    stop();
  });
});
