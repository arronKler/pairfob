import { describe, expect, test } from "bun:test";
import type { LayoutSplit, TabLayout } from "../../../lib/layout";
import type { ResizePaneInput } from "../../../lib/operations";
import {
  dividerCells,
  dividerMoveRequest,
  herdrNavMove,
  layoutDividers,
  paneDivider,
  paneStepMove,
  snapDividerRatio,
} from "./divider";

// implementation | review (top) / dev (bottom), in herdr's own numbers.
const splits: LayoutSplit[] = [
  { id: "split_0_root", direction: "right", ratio: 0.5164319, rect: { x: 0, y: 0, width: 213, height: 72 } },
  { id: "split_1_1", direction: "down", ratio: 0.56, rect: { x: 110, y: 0, width: 103, height: 72 } },
];
const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "a",
  area: { x: 0, y: 0, width: 213, height: 72 },
  panes: [
    { paneId: "a", focused: true, rect: { x: 0, y: 0, width: 110, height: 72 } },
    { paneId: "b", focused: false, rect: { x: 110, y: 0, width: 103, height: 40 } },
    { paneId: "c", focused: false, rect: { x: 110, y: 40, width: 103, height: 32 } },
  ],
  splits,
};

/**
 * herdr 0.9.x `resize_pane`, written out independently from src/layout.rs:
 * nearest split on the requested edge (distance ≤ 1, overlapping), else the
 * opposite edge; right/down add, left/up subtract; clamp 0.1–0.9.
 */
function herdrApply(target: TabLayout, request: ResizePaneInput): Record<string, number> {
  const pane = target.panes.find((item) => item.paneId === request.pane_id)!.rect;
  const all = layoutDividers(target);
  const pick = (nav: string) => all
    .filter((split) => (nav === "left" || nav === "right") === (split.direction === "right"))
    .filter((split) => nav === "left" || nav === "right"
      ? Math.min(split.rect.y + split.rect.height, pane.y + pane.height) > Math.max(split.rect.y, pane.y)
      : Math.min(split.rect.x + split.rect.width, pane.x + pane.width) > Math.max(split.rect.x, pane.x))
    .map((split) => {
      const edge = nav === "left" ? pane.x : nav === "right" ? pane.x + pane.width : nav === "up" ? pane.y : pane.y + pane.height;
      return { split, distance: Math.abs(split.at - edge) };
    })
    .filter((item) => item.distance <= 1)
    .sort((a, b) => a.distance - b.distance)[0]?.split;
  const opposite = { left: "right", right: "left", up: "down", down: "up" }[request.direction];
  const split = pick(request.direction) ?? pick(opposite);
  const ratios = Object.fromEntries(all.map((item) => [item.id, item.ratio]));
  if (!split) return ratios;
  const grows = request.direction === "right" || request.direction === "down";
  const amount = Math.min(0.5, Math.abs(request.amount ?? 0.05));
  ratios[split.id] = Math.min(0.9, Math.max(0.1, split.ratio + (grows ? amount : -amount)));
  return ratios;
}

describe("herdr dividers", () => {
  test("lines sit where herdr rounds them", () => {
    expect(layoutDividers(layout).map((divider) => [divider.id, divider.at])).toEqual([["split_0_root", 110], ["split_1_1", 40]]);
    expect(dividerCells(splits[0])).toEqual([110, 103]);
  });

  test("an older daemon without splits still gets the same lines from pane rects", () => {
    const derived = layoutDividers({ ...layout, splits: undefined });
    expect(derived.map((divider) => [divider.direction, divider.at, divider.rect])).toEqual([
      ["right", 110, layout.area],
      ["down", 40, { x: 110, y: 0, width: 103, height: 72 }],
    ]);
  });

  test("a zoomed tab or a single pane has no dividers", () => {
    expect(layoutDividers({ ...layout, zoomed: true })).toEqual([]);
    expect(layoutDividers({ ...layout, panes: [layout.panes[0]], splits: [] })).toEqual([]);
  });

  test("a drag snaps to whole cells inside 0.1–0.9 and one request's ±0.5", () => {
    expect(snapDividerRatio(splits[0], 120.4)).toBeCloseTo(120 / 213, 9);
    expect(snapDividerRatio(splits[0], 1)).toBeCloseTo(Math.ceil(213 * 0.1) / 213, 9);
    expect(snapDividerRatio(splits[0], 400, 0.3)).toBeCloseTo(Math.floor(213 * 0.8) / 213, 9);
  });

  test("moving a divider names the pane herdr will resolve to that same divider", () => {
    const root = layoutDividers(layout)[0];
    const right = dividerMoveRequest(layout, root, 120 / 213)!;
    expect(right).toMatchObject({ pane_id: "a", direction: "right" });
    expect(right.amount).toBeCloseTo(120 / 213 - 0.5164319, 9);
    expect(Math.round(213 * herdrApply(layout, right).split_0_root)).toBe(120);

    const left = dividerMoveRequest(layout, root, 100 / 213)!;
    expect(left.direction).toBe("left");
    expect(["b", "c"]).toContain(left.pane_id);
    expect(Math.round(213 * herdrApply(layout, left).split_0_root)).toBe(100);

    const inner = layoutDividers(layout)[1];
    const up = dividerMoveRequest(layout, inner, 30 / 72)!;
    expect(up).toMatchObject({ pane_id: "c", direction: "up" });
    expect(Math.round(72 * herdrApply(layout, up).split_1_1)).toBe(30);
    expect(dividerMoveRequest(layout, root, root.ratio)).toBeNull();
  });

  test("steppers grow and shrink the pane they belong to, on every side", () => {
    const width = (id: string, request: ResizePaneInput) => {
      const ratios = herdrApply(layout, request);
      return id === "a" ? Math.round(213 * ratios.split_0_root) : 213 - Math.round(213 * ratios.split_0_root);
    };
    const height = (id: string, request: ResizePaneInput) => {
      const ratios = herdrApply(layout, request);
      return id === "b" ? Math.round(72 * ratios.split_1_1) : 72 - Math.round(72 * ratios.split_1_1);
    };
    // The right-hand pane used to send "right" for wider, which herdr applies as narrower.
    expect(paneStepMove(layout, "b", "width", true)!.request.direction).toBe("left");
    for (const id of ["a", "b", "c"]) {
      const before = layout.panes.find((pane) => pane.paneId === id)!.rect.width;
      expect(width(id, paneStepMove(layout, id, "width", true)!.request)).toBeGreaterThan(before);
      expect(width(id, paneStepMove(layout, id, "width", false)!.request)).toBeLessThan(before);
    }
    for (const id of ["b", "c"]) {
      const before = layout.panes.find((pane) => pane.paneId === id)!.rect.height;
      expect(height(id, paneStepMove(layout, id, "height", true)!.request)).toBeGreaterThan(before);
      expect(height(id, paneStepMove(layout, id, "height", false)!.request)).toBeLessThan(before);
    }
    expect(paneStepMove(layout, "a", "height", true)).toBeNull();
    expect(paneDivider(layout, "b", "width")?.side).toBe("left");
  });

  test("the desk's herdr keys keep herdr's own fallback", () => {
    const move = herdrNavMove(layout, "b", "right")!;
    expect(move.request).toEqual({ pane_id: "b", direction: "right", amount: 0.05 });
    expect(move.divider.id).toBe("split_0_root");
    expect(herdrApply(layout, move.request).split_0_root).toBeCloseTo(move.targetRatio, 9);
    const atLimit: TabLayout = { ...layout, splits: [{ ...splits[0], ratio: 0.9 }, splits[1]],
      panes: [{ ...layout.panes[0], rect: { x: 0, y: 0, width: 192, height: 72 } }, ...layout.panes.slice(1)] };
    expect(herdrNavMove(atLimit, "a", "right")).toBeNull();
  });
});
