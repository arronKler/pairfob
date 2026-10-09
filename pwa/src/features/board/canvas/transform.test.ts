import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fitBoardCamera } from "../../../lib/layout";
import { boardCamera } from "../model/camera";
import { applyCameraTransform, BOARD_TITLE_MAX_PX, BOARD_TITLE_MIN_PX, cameraWithinViewport, settleCamera } from "./transform";

beforeEach(resetBoardTestDOM);
afterEach(() => { for (const node of [...document.body.children]) if (node.id !== "app") node.remove(); });

function rig(viewWidth: number, viewHeight: number) {
  const viewport = document.createElement("div");
  Object.defineProperty(viewport, "clientWidth", { value: viewWidth });
  Object.defineProperty(viewport, "clientHeight", { value: viewHeight });
  const stage = document.createElement("div");
  stage.style.width = "1600px";
  stage.style.height = "640px";
  viewport.append(stage);
  document.body.append(viewport);
  return stage;
}

const read = (stage: HTMLElement, name: string) => Number(stage.style.getPropertyValue(name));

test("controls keep their screen size at every zoom; title bars only from the fit up", () => {
  const stage = rig(390, 500);
  const fit = fitBoardCamera(390, 500, 1600, 640).scale;
  // Zoomed in past the fit: both counter-scale.
  applyCameraTransform(stage, boardCamera(fit * 2, 0, 0, false));
  expect(read(stage, "--board-control-scale")).toBeCloseTo(1 / (fit * 2), 6);
  expect(read(stage, "--board-chrome-scale")).toBeCloseTo(1 / (fit * 2), 6);
  // Zoomed out below the fit: title bars stop counter-scaling and shrink with the screens.
  applyCameraTransform(stage, boardCamera(fit / 3, 0, 0, false));
  expect(read(stage, "--board-control-scale")).toBeCloseTo(3 / fit, 6);
  expect(read(stage, "--board-chrome-scale")).toBeCloseTo(1 / fit, 6);
});

test("a stage that cannot be measured keeps the plain counter-scale", () => {
  const stage = rig(0, 0);
  applyCameraTransform(stage, boardCamera(0.2, 0, 0, false));
  expect(read(stage, "--board-chrome-scale")).toBeCloseTo(5, 6);
});

test("the title bar is one terminal row tall, kept between 14 and 24px on screen", () => {
  const stage = rig(390, 500);
  const fit = fitBoardCamera(390, 500, 1600, 640).scale;
  const title = () => parseFloat(stage.style.getPropertyValue("--board-title-h"));
  // At the fit a terminal row is about 3px on a phone: the bar takes the floor, not 24px.
  applyCameraTransform(stage, boardCamera(fit, 0, 0, true));
  expect(title()).toBe(Math.max(BOARD_TITLE_MIN_PX, 16 * fit));
  // Zoomed in until a row is 20px: the bar is exactly one row.
  applyCameraTransform(stage, boardCamera(1.25, 0, 0, false));
  expect(title()).toBeCloseTo(20, 6);
  // Further in it stops at 24px.
  applyCameraTransform(stage, boardCamera(3, 0, 0, false));
  expect(title()).toBe(BOARD_TITLE_MAX_PX);
  // Below the fit the bar keeps its fit size and shrinks with the board (chrome scale).
  applyCameraTransform(stage, boardCamera(fit / 2, 0, 0, false));
  expect(title()).toBe(Math.max(BOARD_TITLE_MIN_PX, 16 * fit));
});

test("a pane's screen is told the bar's height in stage pixels, whatever the zoom", () => {
  const stage = rig(390, 500);
  const fit = fitBoardCamera(390, 500, 1600, 640).scale;
  const clear = () => read(stage, "--board-title-clear");
  const onScreen = (scale: number) => clear() * scale;
  // While the bar is one row on screen it is one row of the stage: 16px.
  applyCameraTransform(stage, boardCamera(1.25, 0, 0, false));
  expect(clear()).toBeCloseTo(16, 6);
  // Zoomed in past 24px a row, the bar is less than a row of the stage, and 24px on screen.
  applyCameraTransform(stage, boardCamera(3, 0, 0, false));
  expect(clear()).toBeCloseTo(8, 6);
  expect(onScreen(3)).toBeCloseTo(BOARD_TITLE_MAX_PX, 6);
  // A phone's fit: the bar's floor is several rows of the stage, and still the bar's own height on screen.
  applyCameraTransform(stage, boardCamera(fit, 0, 0, true));
  expect(clear()).toBeCloseTo(BOARD_TITLE_MIN_PX / fit, 6);
  expect(onScreen(fit)).toBeCloseTo(BOARD_TITLE_MIN_PX, 6);
  // Below the fit the bar shrinks with the board, so its share of the stage stays what it was at the fit.
  applyCameraTransform(stage, boardCamera(fit / 2, 0, 0, false));
  expect(clear()).toBeCloseTo(BOARD_TITLE_MIN_PX / fit, 6);
});

test("a camera reaches the screen bounded: what is stored is what is painted", () => {
  const stage = rig(800, 600);
  const stored: unknown[] = [];
  // 1600×640 at 0.75 is 1200×480 on screen; pushed far left, its right edge stops at the viewport's.
  const settled = settleCamera(stage, boardCamera(0.75, -5000, 60, true), (camera) => stored.push(camera));
  expect(settled).toEqual({ scale: 0.75, panX: 800 - 1200, panY: 60, fitted: true });
  expect(stored).toEqual([settled]);
  expect(stage.style.transform).toBe("translate(-400px, 60px) scale(0.75)");
  // A camera already in view is stored and painted as it came.
  const inside = boardCamera(0.75, -200, 60, true);
  expect(settleCamera(stage, inside, () => {})).toBe(inside);
});

test("a stage that cannot be measured is not bounded", () => {
  const adrift = boardCamera(1, -9000, 0, false);
  expect(cameraWithinViewport(rig(0, 0), adrift)).toBe(adrift);
  const bare = document.createElement("div");
  expect(cameraWithinViewport(bare, adrift)).toBe(adrift);
});
