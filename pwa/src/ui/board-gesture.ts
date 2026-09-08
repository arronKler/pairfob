/** Pixels before a drag is pan vs pane-scroll. Below this, release is still a tap. */
export const BOARD_GESTURE_SLOP_PX = 12;
/** Screen pixels of vertical travel that map to one remote TUI line. */
export const BOARD_SCROLL_LINE_PX = 20;
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

export function boardScrollLines(remainder: number, dy: number): { lines: number; direction: "up" | "down"; remainder: number } {
  let next = remainder - dy;
  const count = Math.trunc(Math.abs(next) / BOARD_SCROLL_LINE_PX);
  if (!count) return { lines: 0, direction: "down", remainder: next };
  const direction = next < 0 ? "up" : "down";
  next %= BOARD_SCROLL_LINE_PX;
  return { lines: Math.min(count, 40), direction, remainder: next };
}
