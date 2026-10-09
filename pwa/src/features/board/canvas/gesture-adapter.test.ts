import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import { bindBoardCanvasGestures, type BoardCanvasPorts } from "./gesture-adapter";
import { boardCamera, cameraTransform, type BoardCamera } from "../model/camera";
import { BOARD_GESTURE_SLOP_PX, BOARD_SCROLL_LINE_PX } from "../model/gesture";
import { BOARD_PINCH_CATCH_UP_MOVES } from "../model/pinch";
import { BOARD_SCALE_MAX } from "../../../lib/layout";

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

function harness(camera = boardCamera(1, 0, 0, true), applied = true, extra: Partial<BoardCanvasPorts> = {}) {
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
  const stop = bindBoardCanvasGestures(viewport, stage, layout, { ...ports(camera, record, applied), ...extra });
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
    isPrimary: (extra.pointerId ?? 1) === 1,
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
  for (const node of [...document.body.children]) if (node.id !== "app") node.remove();
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

  test("in placement a tap only leaves placement, while a drag still pans", () => {
    let active = true;
    let ended = 0;
    const { tile, record, stop } = harness(undefined, true, {
      placementActive: () => active,
      endPlacement: () => { ended += 1; active = false; },
    });
    pointer(tile, "pointerdown", { x: 10, y: 10 });
    pointer(tile, "pointerup", { x: 10, y: 10 });
    expect(ended).toBe(1);
    expect(record.clicks).toBe(0);
    active = true;
    pointer(tile, "pointerdown", { x: 10, y: 10 });
    pointer(tile, "pointermove", { x: 60, y: 12 });
    pointer(tile, "pointerup", { x: 60, y: 12 });
    expect(record.cameras.length).toBeGreaterThan(0);
    expect(ended).toBe(1);
    stop();
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
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
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
    // One finger rests: the other's first report waits for a partner, its second needs none.
    pointer(viewport, "pointermove", { x: 150, y: 0 }, { pointerId: 2 });
    expect(record.cameras).toEqual([]);
    pointer(viewport, "pointermove", { x: 200, y: 0 }, { pointerId: 2 });
    expect(record.scrolls).toEqual([]);
    expect(record.cameras).toHaveLength(1);
    const zoomed = record.cameras[0];
    // The first move of the catch-up: a share of the ratio the fingers reached inside the slop.
    expect(zoomed.scale).toBeCloseTo(2 ** (1 / BOARD_PINCH_CATCH_UP_MOVES), 6);
    expect(zoomed.fitted).toBe(true);
    // The stage point that was under the fingers' midpoint is under it still.
    expect((100 - zoomed.panX) / zoomed.scale).toBeCloseTo(50, 6);
    // A few moves on the board is where the fingers are: 100px apart to 220px.
    for (let move = 1; move < BOARD_PINCH_CATCH_UP_MOVES; move++) pointer(viewport, "pointermove", { x: 220, y: 0 }, { pointerId: 2 });
    expect(record.cameras).toHaveLength(BOARD_PINCH_CATCH_UP_MOVES);
    expect(record.cameras.at(-1)!.scale).toBeCloseTo(2.2, 6);
    pointer(viewport, "pointerup", { x: 220, y: 0 }, { pointerId: 2 });
    pointer(viewport, "pointerup", { x: 0, y: 0 }, { pointerId: 1 });
    // Releasing a pinch is not a tap: no tile click is synthesized.
    expect(record.clicks).toBe(0);
    stop();
  });

  test("two fingers sliding together move the board and never zoom it, at the zoom limit too", () => {
    for (const scale of [1, BOARD_SCALE_MAX]) {
      const { viewport, tile, stop, record } = harness(boardCamera(scale, 0, 0, true));
      pointer(tile, "pointerdown", { x: 100, y: 100 }, { pointerId: 1 });
      pointer(tile, "pointerdown", { x: 200, y: 100 }, { pointerId: 2 });
      // A browser reports the fingers one after the other: between the two
      // reports their distance is 15px off, and at 400% the old per-move ratio
      // kept each move back and lost each move out.
      for (let step = 1; step <= 8; step++) {
        pointer(viewport, "pointermove", { x: 100 + step * 15, y: 100 + step * 5 }, { pointerId: 1 });
        expect(record.cameras).toHaveLength(step - 1);
        pointer(viewport, "pointermove", { x: 200 + step * 15, y: 100 + step * 5 }, { pointerId: 2 });
        expect(record.cameras).toHaveLength(step);
      }
      expect(record.cameras.at(-1)).toEqual({ scale, panX: 120, panY: 40, fitted: true });
      expect(record.scrolls).toEqual([]);
      stop();
    }
  });

  test("a report still waiting for its partner is applied as the finger lifts", () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 100, y: 100 }, { pointerId: 1 });
    pointer(tile, "pointerdown", { x: 200, y: 100 }, { pointerId: 2 });
    pointer(viewport, "pointermove", { x: 105, y: 130 }, { pointerId: 1 });
    expect(record.cameras).toEqual([]);
    pointer(viewport, "pointerup", { x: 105, y: 130 }, { pointerId: 1 });
    expect(record.cameras).toEqual([{ scale: 1, panX: 2.5, panY: 15, fitted: true }]);
    // The finger left on the board does not go on to pan or scroll with it.
    pointer(viewport, "pointermove", { x: 260, y: 180 }, { pointerId: 2 });
    pointer(viewport, "pointerup", { x: 260, y: 180 }, { pointerId: 2 });
    expect(record.cameras).toHaveLength(1);
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

  test("a sideways wheel pans the board, over a pane or over empty canvas", async () => {
    const { viewport, tile, stage, stop, record } = harness(boardCamera(2, -100, -50, true));
    const sideways = (target: Element, init: WheelEventInit, shiftKey = false): WheelEvent => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 20, clientY: 20, ...init });
      // The test DOM's wheel event does not carry the modifier keys it was made with.
      Object.defineProperty(event, "shiftKey", { value: shiftKey });
      target.dispatchEvent(event);
      return event;
    };
    // Scrolling right brings what lies to the right into view: the stage moves left.
    const overPane = sideways(tile, { deltaX: 60, deltaY: 8 });
    expect(overPane.defaultPrevented).toBe(true);
    expect(record.cameras).toEqual([{ scale: 2, panX: -160, panY: -50, fitted: true }]);
    expect(stage.style.transform).toBe("translate(-160px, -50px) scale(2)");

    // Empty canvas: a pan, not the zoom a vertical wheel means there.
    sideways(viewport, { deltaX: -40 });
    expect(record.cameras[1]).toEqual({ scale: 2, panX: -120, panY: -50, fitted: true });

    sideways(tile, { deltaY: 120 }, true);
    expect(record.cameras[2]).toEqual({ scale: 2, panX: -240, panY: -50, fitted: true });

    // No pane was scrolled on the computer for any of it.
    await microtasks();
    expect(record.scrolls).toEqual([]);
    expect(record.previews).toEqual([]);
    stop();
  });

  test("a gesture that never passed the slop stays a tap on the tile", () => {
    const { viewport, tile, stop, record } = harness();
    pointer(tile, "pointerdown", { x: 40, y: 40 });
    pointer(viewport, "pointermove", { x: 41, y: 41 });
    const up = pointer(viewport, "pointerup", { x: 41, y: 41 });
    expect(up.defaultPrevented).toBe(true);
    expect(record.clicks).toBe(1);
    expect(record.cameras).toEqual([]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    tile.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(record.clicks).toBe(1);
    stop();
  });

  test("the click of a tap that opened a session never reaches the screen that replaced the board", () => {
    const { viewport, tile, stop } = harness();
    // What the session shows at that spot once the board is gone.
    const under = document.createElement("button");
    let pressed = 0;
    under.addEventListener("click", () => { pressed += 1; });
    document.body.append(under);
    pointer(tile, "pointerdown", { x: 40, y: 40 });
    pointer(viewport, "pointerup", { x: 40, y: 40 });
    stop();
    viewport.remove();
    const late = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    under.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(true);
    expect(pressed).toBe(0);
    // Only that one click: the next press is the reader's own.
    pointer(under, "pointerdown", { x: 40, y: 40 });
    under.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(pressed).toBe(1);
    under.remove();
  });

  test("a tap whose click never comes swallows nothing later", () => {
    const { viewport, tile, stop } = harness();
    const under = document.createElement("button");
    let pressed = 0;
    under.addEventListener("click", () => { pressed += 1; });
    document.body.append(under);
    pointer(tile, "pointerdown", { x: 40, y: 40 });
    pointer(viewport, "pointerup", { x: 40, y: 40 });
    stop();
    // A scripted or assistive activation is not the release's click and goes through at once.
    under.click();
    expect(pressed).toBe(1);
    pointer(under, "pointerdown", { x: 10, y: 10 });
    under.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(pressed).toBe(2);
    under.remove();
  });

  test("a fitted board refits when its box changes; a camera at a scale of the reader's own is left alone", () => {
    const observers: Array<() => void> = [];
    const real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { viewport, stop, record } = harness();
      const size = (width: number, height: number) => {
        Object.defineProperty(viewport, "clientWidth", { configurable: true, value: width });
        Object.defineProperty(viewport, "clientHeight", { configurable: true, value: height });
        viewport.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} }) as DOMRect;
      };
      const fire = () => observers.at(-1)!();
      size(800, 600);
      fire();
      // The first look only notes the fit; the camera is whatever the board opened with.
      expect(record.cameras).toEqual([]);
      size(1200, 500);
      fire();
      // That camera was never at the old box's fit scale: it is the reader's, and stays
      // (bounded into view where the stage can be measured: see box-follow.test.ts).
      expect(record.cameras).toEqual([]);
      // "0" fits the board to the box it has now.
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true }));
      expect(record.cameras).toHaveLength(1);
      const landscape = record.cameras[0];
      size(500, 1200);
      fire();
      expect(record.cameras).toHaveLength(2);
      expect(record.cameras[1].scale).not.toBe(landscape.scale);
      // The same box again changes nothing.
      fire();
      expect(record.cameras).toHaveLength(2);
      stop();
    } finally {
      globalThis.ResizeObserver = real;
    }
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
    // Cancellation must not synthesize a tap.
    expect(record.clicks).toBe(0);
    pointer(viewport, "pointermove", { x: 200, y: 200 });
    expect(record.cameras).toEqual([]);
    expect(record.scrolls).toEqual([]);
    stop();
  });

  for (const prior of ["drag", "tap", "cancel", "contextmenu"] as const) {
    for (const pointerType of ["touch", "mouse", "pen"]) {
      test(`${prior} cannot swallow a fresh ${pointerType} press on placement controls`, () => {
        const { viewport, stage, tile, stop } = harness(undefined, true, { openMenu: () => {} });
        const overlay = document.createElement("button");
        overlay.dataset.boardOverlay = "";
        overlay.innerHTML = "<span>Split here</span>";
        stage.append(overlay);
        let picks = 0;
        overlay.addEventListener("click", () => picks++);
        try {
          pointer(tile, "pointerdown", { x: 10, y: 10 });
          if (prior === "drag") pointer(viewport, "pointermove", { x: 60, y: 10 });
          if (prior === "contextmenu") tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
          pointer(viewport, prior === "cancel" ? "pointercancel" : "pointerup", { x: 10, y: 10 });

          // A trailing click from the old gesture must still be suppressed,
          // even if it lands on an overlay. Only a new press earns a new click.
          const trailing = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
          overlay.dispatchEvent(trailing);
          expect(trailing.defaultPrevented).toBe(true);
          expect(picks).toBe(0);

          const label = overlay.firstElementChild!;
          const down = pointer(label, "pointerdown", { x: 40, y: 40 }, { pointerType });
          pointer(label, "pointerup", { x: 40, y: 40 }, { pointerType });
          const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
          label.dispatchEvent(click);
          expect(down.defaultPrevented).toBe(false);
          expect(click.defaultPrevented).toBe(false);
          expect(picks).toBe(1);
        } finally { stop(); }
      });
    }
  }

  test("an overlay press that joins a canvas pinch still suppresses its click", () => {
    const { viewport, stage, stop, record } = harness();
    const overlay = document.createElement("button");
    overlay.dataset.boardOverlay = "";
    stage.append(overlay);
    try {
      pointer(overlay, "pointerdown", { x: 10, y: 10 }, { pointerId: 1 });
      pointer(stage, "pointerdown", { x: 100, y: 10 }, { pointerId: 2 });
      pointer(viewport, "pointermove", { x: 190, y: 10 }, { pointerId: 2 });
      pointer(viewport, "pointerup", { x: 190, y: 10 }, { pointerId: 2 });
      pointer(overlay, "pointerup", { x: 10, y: 10 }, { pointerId: 1 });
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      overlay.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      // One report, applied as the finger lifts: 90px apart to 180px, past the slop.
      expect(record.cameras[0].scale).toBeCloseTo(2 ** (1 / BOARD_PINCH_CATCH_UP_MOVES));
      expect(record.clicks).toBe(0);
    } finally { stop(); }
  });
});
