import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import { bindBoardCanvasGestures, type BoardCanvasPorts } from "./gesture-adapter";
import { boardCamera, cameraTransform, type BoardCamera } from "../model/camera";
import { BOARD_GESTURE_SLOP_PX, BOARD_SCROLL_LINE_PX } from "../model/gesture";

const layout: TabLayout = {
  workspaceId: "w1",
  tabId: "w1:t1",
  zoomed: false,
  focusedPaneId: "w1:p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};

type Recorded = {
  cameras: BoardCamera[];
  scrolls: Array<{ paneId: string; direction: string; lines: number }>;
  previews: string[];
  opens: string[];
  clicks: number;
};

function recorded(): Recorded {
  return { cameras: [], scrolls: [], previews: [], opens: [], clicks: 0 };
}

function ports(camera: BoardCamera, record: Recorded, applied = true): BoardCanvasPorts {
  let current = camera;
  return {
    readCamera: () => current,
    writeCamera: (next) => {
      current = next;
      record.cameras.push(next);
    },
    scrollPane: (_bound, paneId, direction, lines) => {
      record.scrolls.push({ paneId, direction, lines });
      return Promise.resolve(applied);
    },
    requestPanePreview: (paneId) => record.previews.push(paneId),
    openPane: (paneId) => record.opens.push(paneId),
  };
}

function harness(camera = boardCamera(1, 0, 0, true), applied = true) {
  const record = recorded();
  const viewport = document.createElement("div");
  viewport.className = "board-canvas";
  const stage = document.createElement("div");
  stage.className = "board-stage";
  const tile = document.createElement("button");
  tile.className = "board-pane";
  tile.dataset.paneId = "w1:p1";
  tile.addEventListener("click", () => {
    record.clicks += 1;
  });
  stage.append(tile);
  viewport.append(stage);
  document.body.append(viewport);
  const stop = bindBoardCanvasGestures(viewport, stage, layout, ports(camera, record, applied));
  return { record, viewport, stage, tile, stop, camera };
}

function pointer(
  target: Element,
  type: string,
  at: { x: number; y: number },
  extra: { pointerId?: number; pointerType?: string } = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: extra.pointerId ?? 1,
    pointerType: extra.pointerType ?? "touch",
    clientX: at.x,
    clientY: at.y,
  });
  target.dispatchEvent(event);
  return event;
}

function wheel(target: Element, deltaY: number, at = { x: 20, y: 20 }, modifiers: { ctrlKey?: boolean } = {}): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY,
    clientX: at.x,
    clientY: at.y,
    ctrlKey: modifiers.ctrlKey ?? false,
  });
  target.dispatchEvent(event);
  return event;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 24));
const microtasks = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

beforeEach(resetBoardTestDOM);
afterEach(() => {
  document.body.replaceChildren();
});

describe("board canvas gesture adapter", () => {
  test("binding paints the camera it was given and fits once on the first frame", async () => {
    const { stage, stop, record } = harness(boardCamera(2, 5, 6, false));
    expect(stage.style.transform).toBe("translate(5px, 6px) scale(2)");
    expect(record.cameras).toEqual([]);
    await settle();
    expect(record.cameras).toHaveLength(1);
    expect(record.cameras[0].fitted).toBe(true);
    expect(stage.style.transform).toBe(cameraTransform(record.cameras[0]));
    stop();
  });

  test("an already fitted camera is left alone, and a retired binding never fits", async () => {
    const fitted = harness();
    await settle();
    expect(fitted.record.cameras).toEqual([]);
    fitted.stop();

    const retired = harness(boardCamera(1, 0, 0, false));
    retired.stop();
    await settle();
    expect(retired.record.cameras).toEqual([]);
  });

  test("a drag past the slop pans by the travelled delta and suppresses the click", async () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 100, y: 100 });
    pointer(viewport, "pointermove", { x: 100 + BOARD_GESTURE_SLOP_PX - 1, y: 100 });
    expect(record.cameras).toEqual([]);
    pointer(viewport, "pointermove", { x: 130, y: 100 });
    expect(record.cameras).toHaveLength(1);
    expect(record.cameras[0]).toEqual({ scale: 1, panX: 30, panY: 0, fitted: true });
    pointer(viewport, "pointermove", { x: 140, y: 105 });
    expect(record.cameras[1]).toEqual({ scale: 1, panX: 40, panY: 5, fitted: true });
    // The suppressed click never reaches the tile: a finished drag opens nothing.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    tile.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(record.clicks).toBe(0);
    expect(record.opens).toEqual([]);
    stop();
  });

  test("a mostly-vertical drag on a pane scrolls the remote pane in line steps", async () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 50, y: 100 });
    pointer(viewport, "pointermove", { x: 52, y: 100 + BOARD_SCROLL_LINE_PX * 3 });
    expect(record.cameras).toEqual([]);
    expect(record.scrolls).toEqual([{ paneId: "w1:p1", direction: "up", lines: 3 }]);
    pointer(viewport, "pointermove", { x: 52, y: 100 + BOARD_SCROLL_LINE_PX * 3 + 25 });
    expect(record.scrolls[1]).toEqual({ paneId: "w1:p1", direction: "up", lines: 1 });
    pointer(viewport, "pointerup", { x: 52, y: 185 });
    await microtasks();
    // Every applied scroll and the release ask for the scrolled pane; the bridge
    // debounces those asks into one thumbnail read.
    expect([...new Set(record.previews)]).toEqual(["w1:p1"]);
    expect(record.previews).toHaveLength(3);
    stop();
  });

  test("a scroll the daemon refused earns no thumbnail of its own", async () => {
    const { viewport, tile, stop, record } = harness(boardCamera(1, 0, 0, true), false);
    pointer(tile, "pointerdown", { x: 50, y: 100 });
    pointer(viewport, "pointermove", { x: 50, y: 100 + BOARD_SCROLL_LINE_PX * 2 });
    expect(record.scrolls).toHaveLength(1);
    pointer(viewport, "pointerup", { x: 50, y: 140 });
    await microtasks();
    // Only the release asks, which is the legacy behaviour; the refused scroll does not.
    expect(record.previews).toEqual(["w1:p1"]);
    stop();
  });

  test("the same drag on empty canvas pans instead of scrolling a pane", () => {
    const { viewport, stage, stop, record } = harness();
    pointer(stage, "pointerdown", { x: 10, y: 10 });
    pointer(viewport, "pointermove", { x: 10, y: 60 });
    expect(record.scrolls).toEqual([]);
    expect(record.cameras[0]).toEqual({ scale: 1, panX: 0, panY: 50, fitted: true });
    stop();
  });

  test("a second finger takes the gesture over and pinch-zooms around the midpoint", () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 0, y: 0 }, { pointerId: 1 });
    pointer(tile, "pointerdown", { x: 100, y: 0 }, { pointerId: 2 });
    pointer(viewport, "pointermove", { x: 200, y: 0 }, { pointerId: 2 });
    expect(record.scrolls).toEqual([]);
    expect(record.cameras).toHaveLength(1);
    expect(record.cameras[0].scale).toBeCloseTo(2, 6);
    expect(record.cameras[0].fitted).toBe(true);
    pointer(viewport, "pointerup", { x: 200, y: 0 }, { pointerId: 2 });
    pointer(viewport, "pointerup", { x: 0, y: 0 }, { pointerId: 1 });
    // Releasing a pinch is not a tap: no tile click is synthesized.
    expect(record.clicks).toBe(0);
    stop();
  });

  test("wheel over a pane scrolls it, ctrl+wheel and empty-canvas wheel zoom", async () => {
    const { viewport, tile, stage, stop, record } = harness();
    const paneWheel = wheel(tile, -60);
    expect(paneWheel.defaultPrevented).toBe(true);
    expect(record.scrolls).toEqual([{ paneId: "w1:p1", direction: "up", lines: 3 }]);
    expect(record.cameras).toEqual([]);

    const zoomWheel = wheel(stage, -10, { x: 40, y: 40 }, { ctrlKey: true });
    expect(zoomWheel.defaultPrevented).toBe(true);
    expect(record.cameras).toHaveLength(1);
    expect(record.cameras[0].scale).toBeGreaterThan(1);

    const plainWheel = wheel(viewport, 10, { x: 5, y: 5 });
    expect(plainWheel.defaultPrevented).toBe(true);
    expect(record.cameras[1].scale).toBeLessThan(record.cameras[0].scale);
    await microtasks();
    stop();
  });

  test("a gesture that never passed the slop stays a tap on the tile", () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 40, y: 40 });
    pointer(viewport, "pointermove", { x: 41, y: 41 });
    const up = pointer(viewport, "pointerup", { x: 41, y: 41 });
    expect(up.defaultPrevented).toBe(false);
    expect(record.clicks).toBe(1);
    expect(record.cameras).toEqual([]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    tile.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    stop();
  });

  test("disposing retires listeners, the pending frame and any late scroll result", async () => {
    const { viewport, tile, stop, record } = harness(boardCamera(1, 0, 0, false));
    pointer(tile, "pointerdown", { x: 50, y: 100 });
    pointer(viewport, "pointermove", { x: 50, y: 100 + BOARD_SCROLL_LINE_PX * 2 });
    expect(record.scrolls).toHaveLength(1);
    stop();
    pointer(viewport, "pointermove", { x: 50, y: 300 });
    pointer(viewport, "pointerup", { x: 50, y: 300 });
    wheel(tile, -60);
    await settle();
    await microtasks();
    expect(record.cameras).toEqual([]);
    expect(record.scrolls).toHaveLength(1);
    expect(record.clicks).toBe(0);
    expect(record.previews).toEqual([]);
  });

  test("a cancelled pointer releases the gesture so a later move cannot pan", () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 20, y: 20 });
    pointer(viewport, "pointercancel", { x: 20, y: 20 });
    // Release semantics are unchanged: nothing moved, so the tile keeps its tap.
    expect(record.clicks).toBe(1);
    pointer(viewport, "pointermove", { x: 200, y: 200 });
    expect(record.cameras).toEqual([]);
    expect(record.scrolls).toEqual([]);
    stop();
  });
});
