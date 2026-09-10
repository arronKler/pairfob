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

/**
 * Resolve a one-finger drag that already passed the slop.
 * On a pane, any mostly-vertical move scrolls that pane on the computer.
 * Horizontal/diagonal moves and empty canvas still pan the board.
 * Two-finger gestures stay with the canvas (pinch / pan) and never reach here.
 */
export function boardDragMode(dx: number, dy: number, hitPane: string): "pan" | "scroll" {
  if (!hitPane) return "pan";
  return Math.abs(dy) >= Math.abs(dx) ? "scroll" : "pan";
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
