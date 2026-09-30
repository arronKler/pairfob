/**
 * herdr split dividers and the resize requests that move them.
 *
 * herdr (src/layout.rs, 0.9.x) keeps one float ratio per split, clamped to
 * 0.1–0.9, and draws the first child as `round(length × ratio)` whole cells.
 * `pane.resize { pane_id, direction, amount }` picks the split on the pane's
 * requested edge — else the one on the opposite edge — then adds `amount` for
 * right/down and subtracts it for left/up; amount defaults to 0.05 and is
 * capped at 0.5. So a direction says which way a divider moves, not whether
 * the named pane grows.
 *
 * These helpers turn "put this divider here" or "make this pane wider" into
 * the one request herdr applies to that very divider. Everything is pure: the
 * callers send the request and redraw from the refreshed snapshot.
 */
import type { LayoutRect, LayoutSplit, TabLayoutView } from "../../../lib/layout";
import type { LayoutDirection, ResizePaneInput } from "../../../lib/operations";

export const HERDR_RATIO_MIN = 0.1;
export const HERDR_RATIO_MAX = 0.9;
/** herdr's own step for `pane.resize` without an amount. */
export const HERDR_RESIZE_STEP = 0.05;
/** herdr ignores anything above this in one `pane.resize`. */
export const HERDR_RESIZE_MAX = 0.5;

/** A split plus the absolute cell its line sits on. */
export type Divider = LayoutSplit & { at: number };
export type DividerAxis = "width" | "height";
export type DividerMove = { divider: Divider; targetRatio: number; request: ResizePaneInput };

type Rect = LayoutRect;

const vertical = (split: LayoutSplit) => split.direction === "right";
const origin = (split: LayoutSplit) => (vertical(split) ? split.rect.x : split.rect.y);
const length = (split: LayoutSplit) => (vertical(split) ? split.rect.width : split.rect.height);
const overlaps = (aStart: number, aLen: number, bStart: number, bLen: number) =>
  Math.min(aStart + aLen, bStart + bLen) > Math.max(aStart, bStart);
const clampRatio = (ratio: number) => Math.min(HERDR_RATIO_MAX, Math.max(HERDR_RATIO_MIN, ratio));
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The cell a split's line sits on at `ratio`, with herdr's rounding. */
export function dividerAt(split: LayoutSplit, ratio = split.ratio): number {
  return origin(split) + Math.round(length(split) * ratio);
}

/** Cells on either side of a split at `ratio`: [first child, second child]. */
export function dividerCells(split: LayoutSplit, ratio = split.ratio): [number, number] {
  const first = dividerAt(split, ratio) - origin(split);
  return [first, length(split) - first];
}

/**
 * Rebuild a guillotine split tree from pane rects when the daemon does not
 * forward herdr's splits. Ratios are exact at the cell boundaries herdr drew.
 */
function deriveSplits(area: Rect, rects: Rect[]): LayoutSplit[] {
  const out: LayoutSplit[] = [];
  const walk = (box: Rect, panes: Rect[], path: string) => {
    if (panes.length < 2) return;
    for (const direction of ["right", "down"] as const) {
      const across = direction === "right";
      const start = across ? box.x : box.y;
      const size = across ? box.width : box.height;
      const cuts = [...new Set(panes.map((pane) => (across ? pane.x + pane.width : pane.y + pane.height)))]
        .filter((cut) => cut > start && cut < start + size)
        .sort((a, b) => a - b);
      for (const cut of cuts) {
        const first = panes.filter((pane) => (across ? pane.x + pane.width : pane.y + pane.height) <= cut);
        const second = panes.filter((pane) => (across ? pane.x : pane.y) >= cut);
        if (!first.length || !second.length || first.length + second.length !== panes.length) continue;
        out.push({ id: `derived:${path || "root"}`, direction, ratio: (cut - start) / size, rect: box });
        walk(across ? { ...box, width: cut - box.x } : { ...box, height: cut - box.y }, first, `${path}0`);
        walk(across ? { ...box, x: cut, width: box.x + box.width - cut } : { ...box, y: cut, height: box.y + box.height - cut },
          second, `${path}1`);
        return;
      }
    }
  };
  walk(area, rects, "");
  return out;
}

/** Every divider of a tab, as herdr draws them. A zoomed tab shows none. */
export function layoutDividers(layout: TabLayoutView): Divider[] {
  if (layout.zoomed || layout.panes.length < 2) return [];
  const splits = layout.splits?.length
    ? layout.splits
    : deriveSplits(layout.area, layout.panes.map((pane) => pane.rect));
  return splits.map((split) => ({ ...split, at: dividerAt(split) }));
}

function paneRect(layout: TabLayoutView, paneId: string): Rect | null {
  return layout.panes.find((pane) => pane.paneId === paneId)?.rect ?? null;
}

const OPPOSITE: Record<LayoutDirection, LayoutDirection> = { left: "right", right: "left", up: "down", down: "up" };

function edgeOf(rect: Rect, nav: LayoutDirection): number {
  return nav === "left" ? rect.x : nav === "right" ? rect.x + rect.width : nav === "up" ? rect.y : rect.y + rect.height;
}

function onEdge(dividers: Divider[], rect: Rect, nav: LayoutDirection): Divider | null {
  const across = nav === "left" || nav === "right";
  const edge = edgeOf(rect, nav);
  let best: Divider | null = null;
  for (const divider of dividers) {
    if (vertical(divider) !== across) continue;
    const inRange = across
      ? overlaps(divider.rect.y, divider.rect.height, rect.y, rect.height)
      : overlaps(divider.rect.x, divider.rect.width, rect.x, rect.width);
    const distance = Math.abs(divider.at - edge);
    if (!inRange || distance > 1) continue;
    if (!best || distance < Math.abs(best.at - edge)) best = divider;
  }
  return best;
}

/** herdr's `nearest_resize_split`: the requested edge, else (by default) the opposite one. */
export function edgeDivider(layout: TabLayoutView, paneId: string, nav: LayoutDirection, fallback = true): Divider | null {
  const rect = paneRect(layout, paneId);
  if (!rect) return null;
  const dividers = layoutDividers(layout);
  return onEdge(dividers, rect, nav) ?? (fallback ? onEdge(dividers, rect, OPPOSITE[nav]) : null);
}

/** The divider a pane's width or height hangs on: the far edge first, like herdr's lookup. */
export function paneDivider(layout: TabLayoutView, paneId: string, axis: DividerAxis):
  { divider: Divider; side: LayoutDirection } | null {
  const far: LayoutDirection = axis === "width" ? "right" : "down";
  const near: LayoutDirection = axis === "width" ? "left" : "up";
  const onFar = edgeDivider(layout, paneId, far, false);
  if (onFar) return { divider: onFar, side: far };
  const onNear = edgeDivider(layout, paneId, near, false);
  return onNear ? { divider: onNear, side: near } : null;
}

/**
 * The ratio a drag lands on: snapped to whole cells, kept in herdr's 0.1–0.9
 * and within one request's ±0.5 of where the drag started.
 */
export function snapDividerRatio(divider: LayoutSplit, cell: number, startRatio = divider.ratio): number {
  const start = origin(divider);
  const size = length(divider);
  const low = Math.ceil(start + size * Math.max(HERDR_RATIO_MIN, startRatio - HERDR_RESIZE_MAX) - 1e-9);
  const high = Math.floor(start + size * Math.min(HERDR_RATIO_MAX, startRatio + HERDR_RESIZE_MAX) + 1e-9);
  const at = Math.min(high, Math.max(low, Math.round(cell)));
  return (at - start) / size;
}

/**
 * The one `pane.resize` that moves exactly this divider to `targetRatio`.
 * Moving right/down names a pane whose right/bottom edge is the divider;
 * moving left/up names one whose left/top edge is, so herdr's edge lookup
 * lands on this split and never falls back to another one.
 */
export function dividerMoveRequest(layout: TabLayoutView, divider: Divider, targetRatio: number): ResizePaneInput | null {
  const target = clampRatio(targetRatio);
  const delta = target - divider.ratio;
  if (same(delta, 0)) return null;
  const toFar = delta > 0;
  const across = vertical(divider);
  const nav: LayoutDirection = across ? (toFar ? "right" : "left") : (toFar ? "down" : "up");
  const touching = (slack: number) => layout.panes.find(({ rect }) => {
    const edge = edgeOf(rect, nav);
    const inRange = across
      ? overlaps(divider.rect.y, divider.rect.height, rect.y, rect.height)
      : overlaps(divider.rect.x, divider.rect.width, rect.x, rect.width);
    return inRange && Math.abs(edge - divider.at) <= slack;
  });
  const pane = touching(0) ?? touching(1);
  if (!pane) return null;
  // Near full precision (float noise trimmed): the target is an exact cell boundary and herdr
  // rounds it back to that cell.
  const amount = Math.min(HERDR_RESIZE_MAX, Math.round(Math.abs(delta) * 1e9) / 1e9);
  return { pane_id: pane.paneId, direction: nav, amount };
}

/** Stepper: grow moves the pane's divider away from it, shrink toward it, by one step of that split. */
export function paneStepMove(layout: TabLayoutView, paneId: string, axis: DividerAxis, grow: boolean,
  step = HERDR_RESIZE_STEP): DividerMove | null {
  const found = paneDivider(layout, paneId, axis);
  if (!found) return null;
  const away = found.side === (axis === "width" ? "right" : "down");
  const targetRatio = clampRatio(found.divider.ratio + (grow === away ? step : -step));
  const request = dividerMoveRequest(layout, found.divider, targetRatio);
  return request ? { divider: found.divider, targetRatio, request } : null;
}

/** herdr's resize mode verbatim (desk ⌥+arrow): the pane itself, the raw direction and step. */
export function herdrNavMove(layout: TabLayoutView, paneId: string, nav: LayoutDirection,
  step = HERDR_RESIZE_STEP): DividerMove | null {
  const divider = edgeDivider(layout, paneId, nav);
  if (!divider) return null;
  const targetRatio = clampRatio(divider.ratio + (nav === "right" || nav === "down" ? step : -step));
  if (same(targetRatio, divider.ratio)) return null;
  return { divider, targetRatio, request: { pane_id: paneId, direction: nav, amount: step } };
}
