import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import { bindBoardCanvasGestures, type BoardCanvasPorts } from "./gesture-adapter";
import { boardCamera, cameraTransform, fitCamera, type BoardCamera } from "../model/camera";

/**
 * The board stays in view and follows its box: every way of moving the camera
 * is bounded, and a rotation or a resize refits a board the reader has not
 * zoomed. The stage here is measurable (800×640), unlike the bare one the
 * gesture tests bind.
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

let observers: Array<() => void>;
let realObserver: typeof ResizeObserver;

beforeEach(async () => {
  await resetBoardTestDOM();
  observers = [];
  realObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) { observers.push(callback); }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = realObserver;
  for (const node of [...document.body.children]) if (node.id !== "app") node.remove();
});

function board(camera: BoardCamera, box: { width: number; height: number }, memory: { fit: BoardCamera | null } = { fit: null }) {
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
  const size = (width: number, height: number) => {
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: height });
    viewport.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} }) as DOMRect;
  };
  size(box.width, box.height);
  let current = camera;
  const ports: BoardCanvasPorts = {
    readCamera: () => current,
    writeCamera: (next) => { current = next; },
    scrollPane: () => false,
    requestPanePreview: () => {},
    openPane: () => {},
    readFit: () => memory.fit,
    writeFit: (fit) => { memory.fit = fit; },
  };
  const stop = bindBoardCanvasGestures(viewport, stage, layout, ports);
  // The observer reports the box once as it starts watching, as a browser does.
  const resized = () => observers.at(-1)!();
  resized();
  return { viewport, stage, tile, stop, size, resized, camera: () => current, memory };
}

function pointer(target: Element, type: string, x: number, y: number, pointerType = "touch"): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType, clientX: x, clientY: y }));
}

function sideways(target: Element, deltaX: number, shiftKey = false): void {
  const event = new WheelEvent("wheel", shiftKey ? { bubbles: true, cancelable: true, deltaY: deltaX } : { bubbles: true, cancelable: true, deltaX });
  Object.defineProperty(event, "shiftKey", { value: shiftKey });
  target.dispatchEvent(event);
}

const fitFor = (width: number, height: number) => fitCamera(width, height, STAGE);

describe("the board cannot be moved out of view", () => {
  test("sideways wheels stop with the board's edge at the canvas's, and come straight back", () => {
    const fit = fitFor(800, 700);
    const { viewport, stage, stop, camera } = board(fit, { width: 800, height: 700 });
    const shown = STAGE.width * fit.scale;
    for (let turn = 0; turn < 6; turn++) sideways(viewport, 200);
    expect(camera().panX).toBe(0);
    expect(stage.style.transform).toBe(cameraTransform(camera()));
    // Nothing was banked past the bound: one wheel the other way moves the board at once.
    sideways(viewport, -10, true);
    expect(camera().panX).toBe(10);
    for (let turn = 0; turn < 14; turn++) sideways(viewport, -200);
    expect(camera().panX).toBeCloseTo(800 - shown, 6);
    stop();
  });

  test("a finger or a mouse dragging the canvas meets the same bound on both axes", () => {
    for (const pointerType of ["touch", "mouse"]) {
      const fit = fitFor(800, 700);
      const { viewport, stage, stop, camera } = board(fit, { width: 800, height: 700 });
      pointer(stage, "pointerdown", 700, 600, pointerType);
      pointer(viewport, "pointermove", 400, 300, pointerType);
      pointer(viewport, "pointermove", -2600, -2700, pointerType);
      pointer(viewport, "pointerup", -2600, -2700, pointerType);
      // The whole board is still on the canvas, in its top left corner.
      expect(camera().panX).toBe(0);
      expect(camera().panY).toBe(0);
      stop();
    }
  });

  test("a board zoomed past its canvas stops edge to edge on both axes, for a wheel and a drag alike", () => {
    // 1600×1280 on screen in 800×700: 800px lie beyond it sideways, 580px below.
    const { viewport, stage, stop, camera } = board(boardCamera(2, 0, 0, true), { width: 800, height: 700 });
    for (let turn = 0; turn < 8; turn++) sideways(viewport, 200);
    expect(camera().panX).toBe(800 - 1600);
    for (let turn = 0; turn < 8; turn++) sideways(viewport, -200);
    expect(camera().panX).toBe(0);
    pointer(stage, "pointerdown", 700, 600, "mouse");
    pointer(viewport, "pointermove", 600, 580, "mouse");
    pointer(viewport, "pointermove", -4000, -4000, "mouse");
    pointer(viewport, "pointerup", -4000, -4000, "mouse");
    expect(camera()).toEqual({ scale: 2, panX: 800 - 1600, panY: 700 - 1280, fitted: true });
    pointer(stage, "pointerdown", 100, 100, "mouse");
    pointer(viewport, "pointermove", 200, 120, "mouse");
    pointer(viewport, "pointermove", 4000, 4000, "mouse");
    pointer(viewport, "pointerup", 4000, 4000, "mouse");
    expect(camera()).toEqual({ scale: 2, panX: 0, panY: 0, fitted: true });
    stop();
  });

  test("a zoom that would carry the board away is bounded too, while a zoomed-in board pans edge to edge", () => {
    const { viewport, stage, stop, camera } = board(boardCamera(1, 300, 0, true), { width: 800, height: 700 });
    // Ctrl-wheel in at the top left corner pushes the stage away from the pointer; it may not leave a gap there.
    for (let step = 0; step < 40; step++) {
      const zoom = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true });
      Object.defineProperties(zoom, { clientX: { value: 20 }, clientY: { value: 20 } });
      viewport.dispatchEvent(zoom);
    }
    expect(camera().scale).toBe(4);
    expect(camera().panX).toBeLessThanOrEqual(0);
    expect(camera().panY).toBeLessThanOrEqual(0);
    // 3200×2560 on screen: dragging brings the far corner all the way in.
    pointer(stage, "pointerdown", 780, 680, "mouse");
    pointer(viewport, "pointermove", 700, 600, "mouse");
    pointer(viewport, "pointermove", -4000, -4000, "mouse");
    pointer(viewport, "pointerup", -4000, -4000, "mouse");
    expect(camera().panX + 3200).toBe(800);
    expect(camera().panY + 2560).toBe(700);
    stop();
  });
});

describe("the board follows its box", () => {
  test("a board slid about at the fit's scale is fitted again when the box turns", () => {
    const portrait = fitFor(390, 670);
    const { viewport, stage, stop, size, resized, camera } = board(portrait, { width: 390, height: 670 });
    pointer(stage, "pointerdown", 300, 640);
    pointer(viewport, "pointermove", 225, 700);
    pointer(viewport, "pointerup", 225, 700);
    expect(camera().scale).toBe(portrait.scale);
    expect(camera().panX).not.toBe(portrait.panX);
    size(844, 216);
    resized();
    expect(camera()).toEqual(fitFor(844, 216));
    stop();
  });

  test("a zoomed camera is the reader's: it keeps its scale and is only brought back into view", () => {
    const portrait = fitFor(390, 670);
    const { stop, size, resized, camera } = board(boardCamera(1.5, -700, 300, true), { width: 390, height: 670 });
    expect(camera().scale).not.toBeCloseTo(portrait.scale, 3);
    size(844, 216);
    resized();
    // 1200×960 in the short box: its top edge would sit below it and its right edge inside it; both come to the box's edges.
    expect(camera()).toEqual({ scale: 1.5, panX: 844 - 1200, panY: 0, fitted: true });
    // In view already: the same box again writes nothing.
    const kept = camera();
    resized();
    expect(camera()).toBe(kept);
    stop();
  });

  test("a board that was away while its box changed is still known to have been fitted", () => {
    const memory = { fit: null as BoardCamera | null };
    const first = board(fitFor(390, 670), { width: 390, height: 670 }, memory);
    first.stop();
    expect(memory.fit).toEqual(fitFor(390, 670));
    // A session was open over the board while the phone turned; the board binds again in the new box.
    const back = board(first.camera(), { width: 844, height: 216 }, memory);
    expect(back.camera()).toEqual(fitFor(844, 216));
    back.stop();
  });

  test("a camera that was never fitted is left for the first frame", () => {
    const { stop, camera } = board(boardCamera(2, 5, 6, false), { width: 800, height: 700 });
    expect(camera()).toEqual(boardCamera(2, 5, 6, false));
    stop();
  });
});
