import { describe, expect, test } from "bun:test";
import type { LayoutSplit, TabLayout } from "../../../lib/layout";
import { layoutWithSplitRatio } from "./layout-draft";

// a | (b over (c | d)), in herdr's own numbers.
const splits: LayoutSplit[] = [
  { id: "split_0_root", direction: "right", ratio: 0.5164319, rect: { x: 0, y: 0, width: 213, height: 72 } },
  { id: "split_1_1", direction: "down", ratio: 0.56, rect: { x: 110, y: 0, width: 103, height: 72 } },
  { id: "split_2_1", direction: "right", ratio: 0.5, rect: { x: 110, y: 40, width: 103, height: 32 } },
];
const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "a",
  area: { x: 0, y: 0, width: 213, height: 72 },
  panes: [
    { paneId: "a", focused: true, rect: { x: 0, y: 0, width: 110, height: 72 } },
    { paneId: "b", focused: false, rect: { x: 110, y: 0, width: 103, height: 40 } },
    { paneId: "c", focused: false, rect: { x: 110, y: 40, width: 52, height: 32 } },
    { paneId: "d", focused: false, rect: { x: 162, y: 40, width: 51, height: 32 } },
  ],
  splits,
};
const rects = (value: TabLayout) => Object.fromEntries(value.panes.map((pane) => [pane.paneId, pane.rect]));

describe("layout drafts", () => {
  test("moving the root split re-lays every pane and keeps inner ratios, with herdr rounding", () => {
    const draft = layoutWithSplitRatio(layout, "split_0_root", 120 / 213);
    expect(rects(draft)).toEqual({
      a: { x: 0, y: 0, width: 120, height: 72 },
      b: { x: 120, y: 0, width: 93, height: 40 },
      // The inner split stays at 0.5 of its now narrower row: round(93 × 0.5) = 47.
      c: { x: 120, y: 40, width: 47, height: 32 },
      d: { x: 167, y: 40, width: 46, height: 32 },
    });
    expect(draft.splits?.map((split) => [split.id, split.ratio, split.rect.x, split.rect.width])).toEqual([
      ["split_0_root", 120 / 213, 0, 213],
      ["split_1_1", 0.56, 120, 93],
      ["split_2_1", 0.5, 120, 93],
    ]);
  });

  test("a nested split moves only its own children", () => {
    const draft = layoutWithSplitRatio(layout, "split_1_1", 30 / 72);
    expect(rects(draft).a).toEqual(layout.panes[0].rect);
    expect(rects(draft).b).toEqual({ x: 110, y: 0, width: 103, height: 30 });
    expect(rects(draft).c).toEqual({ x: 110, y: 30, width: 52, height: 42 });
  });

  test("older daemons without splits preview through the derived tree", () => {
    const older = { ...layout, splits: undefined };
    const draft = layoutWithSplitRatio(older, "derived:root", 100 / 213);
    expect(rects(draft).a.width).toBe(100);
    expect(rects(draft).b.x).toBe(100);
    expect(draft.splits).toBeUndefined();
  });

  test("an unknown split, a zoomed tab or data that does not nest leaves the layout alone", () => {
    expect(layoutWithSplitRatio(layout, "nope", 0.3)).toBe(layout);
    const zoomed = { ...layout, zoomed: true };
    expect(layoutWithSplitRatio(zoomed, "split_0_root", 0.3)).toBe(zoomed);
    const broken = { ...layout, panes: layout.panes.map((pane) => pane.paneId === "d" ? { ...pane, rect: { ...pane.rect, width: 40 } } : pane) };
    expect(layoutWithSplitRatio(broken, "split_0_root", 0.3)).toBe(broken);
  });
});
