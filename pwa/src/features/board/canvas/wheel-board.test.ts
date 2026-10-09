import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import { bindBoardCanvasGestures } from "./gesture-adapter";
import { boardCamera, fitCamera, type BoardCamera } from "../model/camera";

/**
 * A vertical wheel over a pane. On a board that fits it scrolls that pane on
 * the computer, as it always did. On a board zoomed past its window it moves
 * the board first, as far as the board's edge, and only a wheel turned again
 * after that scrolls the pane. The stage here is measurable (800×640).
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

function board(camera: BoardCamera) {
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
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: VIEW.width });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: VIEW.height });
  let current = camera;
  const scrolls: string[] = [];
  const stop = bindBoardCanvasGestures(viewport, stage, layout, {
    readCamera: () => current,
    writeCamera: (next) => { current = next; },
    scrollPane: (_layout, paneId, direction, lines) => { scrolls.push(`${paneId} ${direction} ${lines}`); return true; },
    requestPanePreview: () => {},
    openPane: () => {},
  });
  /** One wheel event at a time of the test's choosing: only a pause separates two turns of the wheel. */
  let clock = 1000;
  const wheel = (target: Element, deltaY: number, afterMs = 16, init: WheelEventInit = {}): WheelEvent => {
    clock += afterMs;
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ...init });
    Object.defineProperty(event, "timeStamp", { value: clock });
    // The test DOM's wheel event does not carry the modifier keys it was made with.
    Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey === true });
    target.dispatchEvent(event);
    return event;
  };
  return { viewport, stage, tile, stop, wheel, scrolls, camera: () => current };
}

describe("a vertical wheel over a pane", () => {
  test("on a board that fits it scrolls the pane and leaves the board where it is", () => {
    const fit = fitCamera(VIEW.width, VIEW.height, STAGE);
    const { tile, stop, wheel, scrolls, camera } = board(fit);
    expect(wheel(tile, 60).defaultPrevented).toBe(true);
    wheel(tile, -40);
    expect(scrolls).toEqual(["w1:p1 down 3", "w1:p1 up 2"]);
    expect(camera()).toBe(fit);
    stop();
  });

  test("on a board zoomed past its window it moves the board, and scrolls nothing", () => {
    // 1280px tall in a 600px window, 100px of it above.
    const { tile, stop, wheel, scrolls, camera } = board(boardCamera(2, -300, -100, true));
    expect(wheel(tile, 120).defaultPrevented).toBe(true);
    expect(camera()).toEqual({ scale: 2, panX: -300, panY: -220, fitted: true });
    wheel(tile, -500);
    // Up again, and no further than the board's top edge.
    expect(camera().panY).toBe(0);
    expect(scrolls).toEqual([]);
    stop();
  });

  test("the turn that brought the board to its edge does not go on into the pane; the next turn does", () => {
    const { tile, stop, wheel, scrolls, camera } = board(boardCamera(2, -300, -620, true));
    // 60px of the board are left below. The wheel keeps coming, as a trackpad's glide does.
    wheel(tile, 100);
    expect(camera().panY).toBe(600 - 1280);
    for (let tail = 0; tail < 20; tail++) wheel(tile, 100);
    expect(scrolls).toEqual([]);
    expect(camera().panY).toBe(600 - 1280);
    // After a rest the wheel is the pane's: the board's bottom edge is in view.
    wheel(tile, 100, 400);
    wheel(tile, 100);
    expect(scrolls).toEqual(["w1:p1 down 5", "w1:p1 down 5"]);
    // And back up the board moves at once: it is the nearer need again.
    wheel(tile, -100);
    expect(camera().panY).toBe(600 - 1280 + 100);
    expect(scrolls).toHaveLength(2);
    stop();
  });

  test("a wheel that counts lines moves the board a readable distance", () => {
    const { tile, stop, wheel, camera } = board(boardCamera(2, -300, -100, true));
    wheel(tile, 3, 16, { deltaMode: 1 });
    expect(camera().panY).toBe(-196);
    stop();
  });

  test("sideways, Ctrl and the empty canvas keep their meaning on a zoomed board", () => {
    const { viewport, tile, stop, wheel, scrolls, camera } = board(boardCamera(2, -300, -100, true));
    wheel(tile, 8, 16, { deltaX: 60 });
    expect(camera()).toEqual({ scale: 2, panX: -360, panY: -100, fitted: true });
    wheel(tile, -10, 16, { ctrlKey: true, clientX: 40, clientY: 40 });
    expect(camera().scale).toBeGreaterThan(2);
    const zoomedIn = camera().scale;
    wheel(viewport, 10, 16, { clientX: 5, clientY: 5 });
    expect(camera().scale).toBeLessThan(zoomedIn);
    expect(scrolls).toEqual([]);
    stop();
  });
});
