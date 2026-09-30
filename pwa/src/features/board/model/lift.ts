/**
 * Lift-to-swap targets.
 *
 * `pane.swap` names only a direction, and herdr resolves it to exactly one
 * pane (`herdrNeighbor`). So each direction offers that one pane and nothing
 * else: a drop can never land on a pane herdr would not pick.
 */
import type { TabLayoutView } from "../../../lib/layout";
import type { LayoutDirection } from "../../../lib/operations";
import { herdrNeighbor } from "./pane-menu";

const DIRECTIONS: LayoutDirection[] = ["left", "right", "up", "down"];

export function swapTargets(layout: TabLayoutView | null, paneId: string): Map<string, LayoutDirection> {
  const targets = new Map<string, LayoutDirection>();
  if (!layout || layout.zoomed) return targets;
  for (const direction of DIRECTIONS) {
    const id = herdrNeighbor(layout, paneId, direction);
    if (id && !targets.has(id)) targets.set(id, direction);
  }
  return targets;
}
