/**
 * Divider drag geometry.
 *
 * Screen points become terminal cells through the stage's own box, so the
 * drag needs no camera read: the stage rect already carries pan and scale.
 * The first-side pane is what a tap on a divider opens the stepper for.
 */
import { BOARD_CELL_H, BOARD_CELL_W, type LayoutRect, type TabLayoutView } from "../../../lib/layout";
import { dividerCells, type Divider } from "./divider";

export type StageBox = { left: number; top: number; scale: number };

/** Where a stage box sits on screen; `scale` is its rendered/CSS width ratio. */
export function stageBox(stage: { getBoundingClientRect(): DOMRect; offsetWidth: number }): StageBox {
  const rect = stage.getBoundingClientRect();
  return { left: rect.left, top: rect.top, scale: stage.offsetWidth > 0 ? rect.width / stage.offsetWidth : 1 };
}

/** The (fractional) cell under a client point along the divider's axis. */
export function cellAt(divider: Divider, area: LayoutRect, box: StageBox, clientX: number, clientY: number): number {
  const across = divider.direction === "right";
  const offset = across ? (clientX - box.left) / box.scale / BOARD_CELL_W : (clientY - box.top) / box.scale / BOARD_CELL_H;
  return (across ? area.x : area.y) + offset;
}

/** The pane on the divider's first side (left or top) touching the line. */
export function firstSidePane(layout: TabLayoutView, divider: Divider): string {
  const across = divider.direction === "right";
  // Exact edge first, then herdr's one-cell slack (dividerMoveRequest accepts the same).
  const touching = (slack: number) => layout.panes.find(({ rect }) => across
    ? Math.abs(rect.x + rect.width - divider.at) <= slack && rect.y < divider.rect.y + divider.rect.height && divider.rect.y < rect.y + rect.height
    : Math.abs(rect.y + rect.height - divider.at) <= slack && rect.x < divider.rect.x + divider.rect.width && divider.rect.x < rect.x + rect.width);
  return (touching(0) ?? touching(1))?.paneId ?? "";
}

/** Bubble numbers: cells either side and the first side's share. */
export function dragReadout(divider: Divider, ratio: number): { first: number; second: number; share: number; rows: boolean } {
  const [first, second] = dividerCells(divider, ratio);
  return { first, second, share: Math.round(ratio * 100), rows: divider.direction === "down" };
}
