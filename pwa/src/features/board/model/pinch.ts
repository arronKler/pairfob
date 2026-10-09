/**
 * Two fingers on the board.
 *
 * Pure geometry behind the canvas's two-finger gesture: the fingers' midpoint
 * carries the board with it, and the distance between them zooms around that
 * midpoint. Each step returns a new camera and the measure the next step
 * continues from; the adapter decides when a step runs and bounds the result.
 */
import { clampBoardScale } from "../../../lib/layout";
import { panCamera, zoomCameraAt, type BoardCamera } from "./camera";

/**
 * How far the fingers' distance must change before they zoom. Two fingers
 * sliding together never keep it exact, and until it changes this much they
 * only move the board. It is a threshold and not a discount: once it is passed
 * the zoom follows the fingers' whole ratio from where they started.
 */
export const BOARD_PINCH_SLOP_PX = 12;

/**
 * Moves over which the board catches up with the ratio the fingers had already
 * reached when the zoom began. In one move it would jump by the slop it waited
 * out; never, and a pinch zooms less than the fingers spread.
 */
export const BOARD_PINCH_CATCH_UP_MOVES = 4;

type Point = { x: number; y: number };

export type Pinch = {
  /** The fingers' midpoint at the last step. */
  mid: Point;
  /** The distance and the scale the zoom is measured from. */
  span: number;
  scale: number;
  /** The distance has changed past the slop: from here it zooms. */
  zooming: boolean;
  /** The part of the fingers' ratio the board has yet to follow, as a factor; 1 once it has caught up. */
  lag: number;
  /** Moves the catch-up still has. */
  catchUp: number;
};

const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export function startPinch(a: Point, b: Point, scale: number): Pinch {
  return { mid: middle(a, b), span: distance(a, b), scale, zooming: false, lag: 1, catchUp: 0 };
}

/**
 * One step of the gesture. The scale is always the measured one times the
 * distance's ratio to its measure, never a product of per-move ratios: at the
 * zoom limits those lose every move that would pass the limit and keep every
 * move back, so a pan with two fingers crept away from 400%.
 */
export function stepPinch(
  pinch: Pinch,
  camera: BoardCamera,
  origin: { left: number; top: number },
  a: Point,
  b: Point,
): { pinch: Pinch; camera: BoardCamera } {
  const mid = middle(a, b);
  const span = distance(a, b);
  let next = panCamera(camera, mid.x - pinch.mid.x, mid.y - pinch.mid.y);
  let { span: from, scale, zooming, lag, catchUp } = pinch;
  if (!(span > 0) || !(from > 0)) return { pinch: { ...pinch, mid }, camera: next };
  if (!zooming && Math.abs(span - from) >= BOARD_PINCH_SLOP_PX) {
    // The board has followed none of the ratio the fingers are at: it owes all of it.
    zooming = true;
    lag = span / from;
    catchUp = BOARD_PINCH_CATCH_UP_MOVES;
  }
  if (zooming) {
    // An equal share of what is owed each move (equal as a factor), the last one clearing it.
    if (catchUp > 0) { catchUp -= 1; lag = catchUp ? lag ** (catchUp / (catchUp + 1)) : 1; }
    const wanted = scale * (span / from) / lag;
    const bounded = clampBoardScale(wanted);
    next = zoomCameraAt(next, origin, mid.x, mid.y, bounded) ?? next;
    // Past a limit the measure starts over there: turning back zooms at once
    // instead of first undoing travel the board never followed.
    if (bounded !== wanted) { from = span; scale = bounded; lag = 1; catchUp = 0; }
  }
  return { pinch: { mid, span: from, scale, zooming, lag, catchUp }, camera: next };
}
