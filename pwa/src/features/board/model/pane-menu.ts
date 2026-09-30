import { t } from "../../../lib/i18n";
import type { TabLayoutView } from "../../../lib/layout";
import type { LayoutDirection, OperationCapabilities } from "../../../lib/operations";
import { paneDivider } from "./divider";

export type BoardPaneAction = "open" | "rename" | "split" | "resize" | "swap" | "zoom" | "close";
export type BoardLayoutAction = { kind: "resize" | "swap"; direction: LayoutDirection };
/** Sections in the order the session row menu uses: the pane, its layout, then destructive management. */
export type PaneMenuGroup = "pane" | "layout" | "manage";
export type PaneMenuEntry = {
  id: BoardPaneAction;
  label: string;
  group: PaneMenuGroup;
  /** Why the row cannot run right now; shown as its detail line. */
  reason?: string;
  /** What the row leads to, shown when it can run. */
  detail?: string;
  danger?: boolean;
};
export type PaneMenuModel = {
  title: string;
  subtitle: string;
  entries: PaneMenuEntry[];
  disabledReason: string;
  layout: TabLayoutView | null;
  paneId: string;
  notice: string;
};

/** Candidate rectangles, not a promise about the daemon's neighbor selection. */
export function directionalPanes(layout: TabLayoutView | null, paneId: string, direction: LayoutDirection): string[] {
  const pane = layout?.panes.find(pane => pane.paneId === paneId);
  if (!pane || !layout || layout.zoomed) return [];
  const a = pane.rect;
  return layout.panes.filter(other => {
    if (other.paneId === paneId) return false;
    const b = other.rect;
    const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
    const horizontalOverlap = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
    switch (direction) {
      case "left": return verticalOverlap && b.x + b.width <= a.x;
      case "right": return verticalOverlap && b.x >= a.x + a.width;
      case "up": return horizontalOverlap && b.y + b.height <= a.y;
      case "down": return horizontalOverlap && b.y >= a.y + a.height;
    }
  }).map(pane => pane.paneId);
}

/**
 * Whether a swap or resize on that axis can run. A resize names an axis only:
 * which way herdr must be told to move is `divider.ts`'s job, never "wider is
 * right".
 */
/**
 * The one pane herdr's directional `pane.swap` (and focus move) resolves to:
 * `find_in_direction` in herdr's src/layout.rs — nearest edge first, then the
 * larger overlap, then the closer centre, then layout order.
 */
export function herdrNeighbor(layout: TabLayoutView | null, paneId: string, direction: LayoutDirection): string | null {
  const source = layout?.panes.find(pane => pane.paneId === paneId);
  if (!source || !layout || layout.zoomed) return null;
  const a = source.rect;
  const across = direction === "left" || direction === "right";
  const candidates = new Set(directionalPanes(layout, paneId, direction));
  const before = (x: number[], y: number[]) => {
    for (let at = 0; at < x.length; at++) if (x[at] !== y[at]) return x[at] < y[at];
    return false;
  };
  let best: { id: string; key: number[] } | null = null;
  for (const [index, pane] of layout.panes.entries()) {
    if (!candidates.has(pane.paneId)) continue;
    const b = pane.rect;
    const edge = direction === "left" ? a.x - (b.x + b.width) : direction === "right" ? b.x - (a.x + a.width)
      : direction === "up" ? a.y - (b.y + b.height) : b.y - (a.y + a.height);
    const [aStart, aLen, bStart, bLen] = across ? [a.y, a.height, b.y, b.height] : [a.x, a.width, b.x, b.width];
    const overlap = Math.max(0, Math.min(aStart + aLen, bStart + bLen) - Math.max(aStart, bStart));
    // Doubled so the centre distance stays an integer, like herdr's u16 maths.
    const centre = Math.abs((2 * bStart + bLen) - (2 * aStart + aLen));
    const key = [edge, -overlap, centre, index];
    if (!best || before(key, best.key)) best = { id: pane.paneId, key };
  }
  return best?.id ?? null;
}

export function layoutActionReason(model: PaneMenuModel, action: BoardLayoutAction): string {
  if (model.disabledReason) return model.disabledReason;
  const layout = model.layout;
  if (!layout || layout.zoomed || layout.panes.length < 2) return t("boardMenu.unavailable");
  if (action.kind === "swap") return directionalPanes(layout, model.paneId, action.direction).length ? "" : t("boardMenu.noNeighbor");
  const axis = action.direction === "left" || action.direction === "right" ? "width" : "height";
  return paneDivider(layout, model.paneId, axis) ? "" : t("boardMenu.unavailable");
}

/** Where a pane sits on the computer's screen, in a word or two. */
export function panePosition(layout: TabLayoutView | null, paneId: string): string {
  const rect = layout?.panes.find(pane => pane.paneId === paneId)?.rect;
  if (!layout || !rect || layout.zoomed) return t("boardMenu.positionFull");
  const { area } = layout;
  const h = rect.width >= area.width ? "" : t(rect.x <= area.x ? "boardMenu.h.left" : "boardMenu.h.right");
  const v = rect.height >= area.height ? "" : t(rect.y <= area.y ? "boardMenu.v.top" : "boardMenu.v.bottom");
  if (h && v) return t("boardMenu.positionCorner", { h, v });
  if (h) return t("boardMenu.positionH", { h });
  if (v) return t("boardMenu.positionV", { v });
  return t("boardMenu.positionFull");
}

/**
 * The pane menu, gated by the advertised capabilities: an action the computer
 * does not offer is absent, one it cannot run right now stays visible with
 * its reason.
 */
export function paneMenuEntries(caps: OperationCapabilities, layout: TabLayoutView | null, disabledReason: string): PaneMenuEntry[] {
  const split = !!layout && layout.panes.length > 1;
  const zoomed = !!layout?.zoomed;
  const arranged = zoomed ? t("boardMenu.zoomedReason") : "";
  const entries: PaneMenuEntry[] = [
    { id: "open", label: t("boardMenu.open"), group: "pane" },
    { id: "rename", label: t("boardMenu.rename"), group: "pane" },
  ];
  if (caps.split_pane) entries.push({ id: "split", label: t("boardMenu.split"), group: "layout", detail: t("boardMenu.splitDetail") });
  if (caps.resize_pane && split) entries.push({ id: "resize", label: t("boardMenu.resize"), group: "layout",
    detail: t("boardMenu.resizeDetail"), reason: arranged || undefined });
  if (caps.swap_pane && split) entries.push({ id: "swap", label: t("boardMenu.swapPick"), group: "layout",
    detail: t("boardMenu.swapDetail"), reason: arranged || undefined });
  if (caps.zoom_pane && (split || zoomed)) entries.push({ id: "zoom",
    label: t(zoomed ? "boardMenu.restore" : "boardMenu.maximize"), group: "layout" });
  entries.push({ id: "close", label: t("boardMenu.close"), group: "manage", danger: true });
  return entries.map(entry => ({ ...entry, reason: disabledReason || entry.reason }));
}
