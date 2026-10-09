import { describe, expect, test } from "bun:test";
import { BOARD_SCALE_MAX, BOARD_SCALE_MIN } from "../../../lib/layout";
import { boardCamera, type BoardCamera } from "./camera";
import { BOARD_PINCH_CATCH_UP_MOVES, BOARD_PINCH_SLOP_PX, startPinch, stepPinch, type Pinch } from "./pinch";

const ORIGIN = { left: 0, top: 0 };
type Point = { x: number; y: number };

/** Walk two fingers through a path, one step per pair of positions. */
function walk(camera: BoardCamera, path: Array<[Point, Point]>): { camera: BoardCamera; pinch: Pinch } {
  let pinch = startPinch(path[0][0], path[0][1], camera.scale);
  for (const [a, b] of path.slice(1)) ({ pinch, camera } = stepPinch(pinch, camera, ORIGIN, a, b));
  return { camera, pinch };
}

const at = (x: number, y: number): Point => ({ x, y });

describe("two fingers on the board", () => {
  test("fingers that keep their distance move the board by their own travel and never zoom it", () => {
    for (const scale of [BOARD_SCALE_MIN, 0.44, 1, 2.5, BOARD_SCALE_MAX]) {
      const start = boardCamera(scale, 10, 20, true);
      const { camera } = walk(start, [
        [at(100, 100), at(200, 130)],
        [at(130, 110), at(230, 140)],
        [at(160, 150), at(260, 180)],
        [at(90, 60), at(190, 90)],
      ]);
      expect(camera).toEqual({ scale, panX: 0, panY: -20, fitted: true });
    }
  });

  test("a distance that only wobbles inside the slop is still a pan", () => {
    const wobble = BOARD_PINCH_SLOP_PX - 1;
    const { camera, pinch } = walk(boardCamera(BOARD_SCALE_MAX, 0, 0, true), [
      [at(100, 100), at(200, 100)],
      [at(110, 100), at(210 + wobble, 100)],
      [at(120, 100), at(220 - wobble, 100)],
      [at(130, 100), at(230, 100)],
    ]);
    expect(pinch.zooming).toBe(false);
    expect(camera.scale).toBe(BOARD_SCALE_MAX);
    expect(camera.panX).toBeCloseTo(30, 6);
  });

  test("past the slop the distance zooms around the midpoint", () => {
    const { camera, pinch } = walk(boardCamera(1, 0, 0, true), [
      [at(100, 0), at(200, 0)],
      [at(50, 0), at(250, 0)],
    ]);
    expect(pinch.zooming).toBe(true);
    expect(camera.scale).toBeGreaterThan(1);
    // The midpoint did not move, so the stage point under it stays there.
    expect((150 - camera.panX) / camera.scale).toBeCloseTo(150, 9);
  });

  test("a deliberate pinch zooms by the fingers' whole ratio: the slop is a threshold, not a discount", () => {
    // 80px apart to 220px in fourteen moves, as a thumb and a finger spread on a phone.
    const spread = Array.from({ length: 15 }, (_, step): [Point, Point] => [at(150 - 40 - 5 * step, 0), at(150 + 40 + 5 * step, 0)]);
    expect(walk(boardCamera(0.4375, 0, 0, true), spread).camera.scale).toBeCloseTo(0.4375 * (220 / 80), 9);
    // And back together again: the same ratio the other way.
    const squeeze = [...spread].reverse();
    expect(walk(boardCamera(2, 0, 0, true), squeeze).camera.scale).toBeCloseTo(2 * (80 / 220), 9);
  });

  test("the ratio waited out inside the slop is caught up over a few moves, never in one", () => {
    // Fingers 80px apart open by 6px a move: the slop is passed on the second.
    let camera = boardCamera(1, 0, 0, true);
    let pinch = startPinch(at(110, 0), at(190, 0), 1);
    const growth: number[] = [];
    for (let step = 1; step <= 8; step++) {
      const before = camera.scale;
      ({ pinch, camera } = stepPinch(pinch, camera, ORIGIN, at(110 - 3 * step, 0), at(190 + 3 * step, 0)));
      growth.push(camera.scale / before);
    }
    expect(growth[0]).toBe(1);
    // The 92/80 owed at the threshold comes in equal shares on top of each move's own change.
    const share = (92 / 80) ** (1 / BOARD_PINCH_CATCH_UP_MOVES);
    for (let move = 1; move <= BOARD_PINCH_CATCH_UP_MOVES; move++) {
      const own = move === 1 ? 1 : (80 + 6 * (move + 1)) / (80 + 6 * move);
      expect(growth[move]).toBeCloseTo(share * own, 9);
    }
    // Caught up: from here the board is exactly where the fingers are.
    expect(pinch.lag).toBe(1);
    expect(camera.scale).toBeCloseTo(128 / 80, 9);
    expect(growth[7]).toBeCloseTo(128 / 122, 9);
  });

  test("fingers that stop right past the slop still get their ratio as soon as they stir", () => {
    let camera = boardCamera(1, 0, 0, true);
    let pinch = startPinch(at(100, 0), at(200, 0), 1);
    for (let move = 0; move < BOARD_PINCH_CATCH_UP_MOVES; move++) {
      ({ pinch, camera } = stepPinch(pinch, camera, ORIGIN, at(90, 0), at(210, 0)));
    }
    expect(camera.scale).toBeCloseTo(1.2, 9);
  });

  test("at the zoom limit a pinch that turns back zooms at once, and its wobble does not ratchet", () => {
    // Out past the limit, then the same distance back: the travel past 400% is not owed.
    const out = walk(boardCamera(3.5, 0, 0, true), [
      [at(100, 0), at(200, 0)],
      [at(50, 0), at(250, 0)],
      [at(0, 0), at(300, 0)],
    ]);
    expect(out.camera.scale).toBe(BOARD_SCALE_MAX);
    const back = stepPinch(out.pinch, out.camera, ORIGIN, at(30, 0), at(270, 0));
    expect(back.camera.scale).toBeCloseTo(BOARD_SCALE_MAX * (240 / 300), 9);
    // Out and in by the same few pixels, many times: the scale is where it started.
    let { pinch, camera } = out;
    for (let turn = 0; turn < 40; turn++) {
      ({ pinch, camera } = stepPinch(pinch, camera, ORIGIN, at(0, 0), at(296, 0)));
      ({ pinch, camera } = stepPinch(pinch, camera, ORIGIN, at(0, 0), at(300, 0)));
    }
    expect(camera.scale).toBe(BOARD_SCALE_MAX);
  });

  test("the same holds at the smallest scale", () => {
    const squeezed = walk(boardCamera(0.2, 0, 0, true), [
      [at(0, 0), at(300, 0)],
      [at(100, 0), at(200, 0)],
      [at(140, 0), at(160, 0)],
    ]);
    expect(squeezed.camera.scale).toBe(BOARD_SCALE_MIN);
    const open = stepPinch(squeezed.pinch, squeezed.camera, ORIGIN, at(130, 0), at(170, 0));
    expect(open.camera.scale).toBeCloseTo(BOARD_SCALE_MIN * 2, 9);
  });

  test("fingers on one point measure nothing and only move the board", () => {
    const { camera, pinch } = walk(boardCamera(2, 0, 0, false), [
      [at(50, 50), at(50, 50)],
      [at(70, 90), at(70, 90)],
    ]);
    expect(camera).toEqual({ scale: 2, panX: 20, panY: 40, fitted: false });
    expect(pinch.zooming).toBe(false);
  });
});
