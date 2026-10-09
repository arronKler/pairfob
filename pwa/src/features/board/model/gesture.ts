/**
 * Board gesture model.
 *
 * Pure decisions behind the canvas gestures: how far a finger travels before a
 * drag means something, whether that drag pans the board or scrolls a pane, how
 * much travel is one remote TUI line, and which grid the remote scroll uses.
 */
import { paneCellGrid, type TabLayout } from "../../../lib/layout";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "../../../lib/protocol/terminal";

/** Pixels before a drag is pan vs pane-scroll. Below this, release is still a tap. */
export const BOARD_GESTURE_SLOP_PX = 12;
/** Screen pixels of vertical travel that map to one remote TUI line. */
export const BOARD_SCROLL_LINE_PX = 20;
/** One drag never scrolls further than this, so a fling cannot drown the daemon. */
export const BOARD_SCROLL_MAX_LINES = 40;
/** A wheel that reports lines instead of pixels pans the board this far per line. */
const BOARD_WHEEL_LINE_PX = 32;

/**
 * Resolve a one-pointer drag that already passed the slop.
 * On a pane, any mostly-vertical move scrolls that pane on the computer.
 * Horizontal/diagonal moves and empty canvas still pan the board.
 * Two-finger gestures stay with the canvas (pinch / pan) and never reach here.
 * For a finger that holds on a board zoomed past its window too: one finger is
 * then the only way to scroll a pane in the middle of it, and two fingers move
 * the board.
 *
 * A mouse has one pointer for both. `boardFirst` is its drag on a board that
 * reaches past the window above or below: it moves the board in every
 * direction, as far as the board's edge, the way its wheel moves that board
 * before it scrolls a pane. The pane is still read with the wheel once the
 * board's edge is in view, and with a drag again once the board fits.
 */
export function boardDragMode(dx: number, dy: number, hitPane: string, boardFirst = false): "pan" | "scroll" {
  if (!hitPane || boardFirst) return "pan";
  return Math.abs(dy) >= Math.abs(dx) ? "scroll" : "pan";
}

/**
 * Sideways travel of a wheel in screen pixels: a trackpad's horizontal swipe,
 * or Shift turning a mouse wheel on its side. It pans the board, as a sideways
 * drag does. 0 for a mostly vertical wheel, which moves a board zoomed past its
 * window, scrolls the pane under it, or zooms the empty canvas.
 */
export function boardWheelPan(
  wheel: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean },
  pageWidth: number,
): number {
  const sideways = wheel.shiftKey && !wheel.deltaX ? wheel.deltaY
    : Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY) ? wheel.deltaX : 0;
  const unit = wheel.deltaMode === 1 ? BOARD_WHEEL_LINE_PX : wheel.deltaMode === 2 ? pageWidth : 1;
  return sideways * unit;
}

/**
 * Vertical travel of a wheel in screen pixels, for moving the board. A wheel
 * that reports lines or pages is scaled as its sideways travel is.
 */
export function boardWheelTravel(wheel: { deltaY: number; deltaMode: number }, pageHeight: number): number {
  return wheel.deltaY * (wheel.deltaMode === 1 ? BOARD_WHEEL_LINE_PX : wheel.deltaMode === 2 ? pageHeight : 1);
}

export function boardScrollLines(
  remainder: number,
  dy: number,
): { lines: number; direction: "up" | "down"; remainder: number } {
  let next = remainder - dy;
  const count = Math.trunc(Math.abs(next) / BOARD_SCROLL_LINE_PX);
  if (!count) return { lines: 0, direction: "down", remainder: next };
  const direction = next < 0 ? "up" : "down";
  next %= BOARD_SCROLL_LINE_PX;
  return { lines: Math.min(count, BOARD_SCROLL_MAX_LINES), direction, remainder: next };
}

/**
 * Remote TUI grid a board scroll drives: the pane cell grid, or the daemon's own
 * viewport rows when it reports them, clamped to what a PTY accepts.
 */
export function scrollGridForPane(
  layout: TabLayout,
  paneId: string,
  viewportRows?: number,
): { cols: number; rows: number } {
  const grid = paneCellGrid(paneId, layout, viewportRows);
  return {
    cols: Math.min(TERMINAL_MAX_COLS, Math.max(TERMINAL_MIN_COLS, grid?.cols || 80)),
    rows: Math.min(TERMINAL_MAX_ROWS, Math.max(TERMINAL_MIN_ROWS, grid?.rows || 24)),
  };
}
