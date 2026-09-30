/**
 * Board layout drafts.
 *
 * A divider drag previews on the phone before anything reaches the computer.
 * This rebuilds herdr's split tree from the tab's dividers (splits nest by rect
 * containment; older daemons get splits derived from pane rects) and lays every
 * pane out again with herdr's rounding — first child `round(length × ratio)`
 * cells, the second child the rest — with one split's ratio overridden. Inner
 * splits keep their own ratios, exactly as herdr redraws them.
 */
import type { LayoutRect, LayoutSplit, TabLayout } from "../../../lib/layout";
import { layoutDividers } from "./divider";

type Node =
  | { kind: "pane"; paneId: string }
  | { kind: "split"; split: LayoutSplit; first: Node; second: Node };

const sameRect = (a: LayoutRect, b: LayoutRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function halves(rect: LayoutRect, split: Pick<LayoutSplit, "direction">, ratio: number): [LayoutRect, LayoutRect] {
  if (split.direction === "right") {
    const first = Math.round(rect.width * ratio);
    return [{ ...rect, width: first }, { ...rect, x: rect.x + first, width: rect.width - first }];
  }
  const first = Math.round(rect.height * ratio);
  return [{ ...rect, height: first }, { ...rect, y: rect.y + first, height: rect.height - first }];
}

/** The split tree the tab was drawn from, or null when the data does not nest cleanly. */
function buildTree(layout: TabLayout): Node | null {
  const splits = layoutDividers(layout);
  const used = new Set<string>();
  const build = (rect: LayoutRect): Node | null => {
    const split = splits.find((item) => !used.has(item.id) && sameRect(item.rect, rect));
    if (split) {
      used.add(split.id);
      const [a, b] = halves(rect, split, split.ratio);
      const first = build(a);
      const second = build(b);
      return first && second ? { kind: "split", split, first, second } : null;
    }
    const pane = layout.panes.find((item) => sameRect(item.rect, rect));
    return pane ? { kind: "pane", paneId: pane.paneId } : null;
  };
  const root = build(layout.area);
  return root && used.size === splits.length ? root : null;
}

/**
 * The tab as herdr would draw it with `splitId` at `ratio`. Returns the layout
 * unchanged when the split is unknown or the tree cannot be rebuilt: a preview
 * never invents geometry the computer would not produce.
 */
export function layoutWithSplitRatio(layout: TabLayout, splitId: string, ratio: number): TabLayout {
  if (layout.zoomed) return layout;
  const root = buildTree(layout);
  if (!root) return layout;
  const rects = new Map<string, LayoutRect>();
  const splits: LayoutSplit[] = [];
  let found = false;
  const place = (node: Node, rect: LayoutRect) => {
    if (node.kind === "pane") { rects.set(node.paneId, rect); return; }
    const own = node.split.id === splitId;
    found ||= own;
    const next = own ? ratio : node.split.ratio;
    splits.push({ ...node.split, ratio: next, rect });
    const [a, b] = halves(rect, node.split, next);
    place(node.first, a);
    place(node.second, b);
  };
  place(root, layout.area);
  if (!found) return layout;
  return {
    ...layout,
    panes: layout.panes.map((pane) => ({ ...pane, rect: rects.get(pane.paneId) ?? pane.rect })),
    // Keep the daemon's own split list shape: only forwarded splits stay forwarded.
    ...(layout.splits?.length ? { splits } : {}),
  };
}
