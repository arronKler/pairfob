import { expect, test } from "bun:test";
import type { TabLayout } from "../../../lib/layout";
import { layoutDividers } from "./divider";
import { cellAt, dragReadout, firstSidePane, stageBox } from "./divider-drag";

const layout: TabLayout = {
  workspaceId: "w1", tabId: "t1", zoomed: false, focusedPaneId: "a",
  area: { x: 4, y: 2, width: 213, height: 72 },
  panes: [
    { paneId: "a", focused: true, rect: { x: 4, y: 2, width: 110, height: 72 } },
    { paneId: "b", focused: false, rect: { x: 114, y: 2, width: 103, height: 40 } },
    { paneId: "c", focused: false, rect: { x: 114, y: 42, width: 103, height: 32 } },
  ],
};

test("a scaled, panned stage maps screen points back to herdr cells", () => {
  const box = stageBox({ getBoundingClientRect: () => ({ left: 30, top: 10, width: 852, height: 0 }) as DOMRect, offsetWidth: 1704 });
  expect(box).toEqual({ left: 30, top: 10, scale: 0.5 });
  const [root, inner] = layoutDividers(layout);
  expect(cellAt(root, layout.area, box, 30 + 110 * 8 * 0.5, 0)).toBe(114);
  expect(cellAt(inner, layout.area, box, 0, 10 + 40 * 16 * 0.5)).toBe(42);
});

test("a tap on a divider opens the pane on its first side; the readout counts both sides", () => {
  const [root, inner] = layoutDividers(layout);
  expect(firstSidePane(layout, root)).toBe("a");
  expect(firstSidePane(layout, inner)).toBe("b");
  expect(dragReadout(root, 120 / 213)).toEqual({ first: 120, second: 93, share: 56, rows: false });
  expect(dragReadout(inner, inner.ratio).rows).toBeTrue();
});
