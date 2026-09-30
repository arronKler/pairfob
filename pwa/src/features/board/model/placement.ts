/**
 * Split placement: which sides of a pane can take a new cell.
 *
 * A side is offered only when both halves stay usable on the computer; the
 * reason names the side that was dropped so the reader is never left guessing.
 */
import type { TabLayoutView } from "../../../lib/layout";
import type { SplitDirection } from "../../../lib/operations";

/** Smallest pane (in cells) that still splits into two usable halves. */
export const SPLIT_MIN_COLS = 20;
export const SPLIT_MIN_ROWS = 8;

export type SplitSides = { right: boolean; down: boolean; missing: SplitDirection[] };

export function splitSides(layout: TabLayoutView | null, paneId: string): SplitSides {
  const rect = layout?.panes.find((pane) => pane.paneId === paneId)?.rect;
  const right = !!rect && rect.width >= SPLIT_MIN_COLS;
  const down = !!rect && rect.height >= SPLIT_MIN_ROWS;
  const missing: SplitDirection[] = [];
  if (!right) missing.push("right");
  if (!down) missing.push("down");
  return { right, down, missing };
}
