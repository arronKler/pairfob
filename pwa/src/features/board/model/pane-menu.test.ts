import { expect, test } from "bun:test";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import type { TabLayout } from "../../../lib/layout";
import { directionalPanes, herdrNeighbor, layoutActionReason, paneMenuEntries, panePosition, type PaneMenuModel } from "./pane-menu";
import { setLang } from "../../../lib/i18n";

setLang("zh");

const layout: TabLayout = { workspaceId: "w", tabId: "t", focusedPaneId: "a", zoomed: false,
  area: { x: 0, y: 0, width: 100, height: 40 }, panes: [
    { paneId: "a", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { paneId: "b", focused: false, rect: { x: 60, y: 0, width: 40, height: 20 } },
    { paneId: "c", focused: false, rect: { x: 60, y: 20, width: 40, height: 20 } },
  ] };
const caps = { ...NO_OPERATION_CAPABILITIES, split_pane: true, resize_pane: true, swap_pane: true, zoom_pane: true };
const model = (paneId: string, extra: Partial<PaneMenuModel> = {}): PaneMenuModel => ({
  title: paneId, subtitle: "", layout, paneId, disabledReason: "", entries: [], notice: "", ...extra,
});

test("missing capabilities never invent layout actions; reconnect keeps actions visibly disabled", () => {
  expect(paneMenuEntries(NO_OPERATION_CAPABILITIES, layout, "").map(entry => entry.id)).toEqual(["open", "rename", "close"]);
  expect(paneMenuEntries(caps, layout, "").map(entry => [entry.id, entry.group])).toEqual([
    ["open", "pane"], ["rename", "pane"], ["split", "layout"], ["resize", "layout"], ["swap", "layout"], ["zoom", "layout"], ["close", "manage"],
  ]);
  expect(paneMenuEntries(caps, layout, "offline").every(entry => entry.reason === "offline")).toBe(true);
});
test("zoomed layout still offers restore with a single visible pane and hides unusable sizing", () => {
  const zoomed = { ...layout, zoomed: true, panes: [layout.panes[0]] };
  expect(paneMenuEntries(caps, zoomed, "").map(entry => entry.id)).toEqual(["open", "rename", "split", "zoom", "close"]);
  // A maximized tab that still lists its cells keeps sizing visible, with the reason.
  const listed = paneMenuEntries(caps, { ...layout, zoomed: true }, "");
  expect(listed.find(entry => entry.id === "resize")?.reason).not.toBe(undefined);
});
test("direction candidates require overlapping edges, including multiple neighbors", () => {
  expect(directionalPanes(layout, "a", "right")).toEqual(["b", "c"]);
  expect(directionalPanes(layout, "b", "down")).toEqual(["c"]);
  expect(directionalPanes(layout, "b", "up")).toEqual([]);
  expect(directionalPanes(layout, "a", "left")).toEqual([]);
});
test("a directional swap resolves to the one pane herdr's find_in_direction picks", () => {
  // a | (b over c): b and c both lie to the right; the larger overlap wins, then layout order.
  expect(herdrNeighbor(layout, "a", "right")).toBe("b");
  const lower = { ...layout, panes: [layout.panes[0], { ...layout.panes[1], rect: { x: 60, y: 0, width: 40, height: 10 } },
    { ...layout.panes[2], rect: { x: 60, y: 10, width: 40, height: 30 } }] };
  expect(herdrNeighbor(lower, "a", "right")).toBe("c");
  // Three columns: the far column is never the target, the nearest edge wins.
  const columns = { ...layout, panes: [
    { paneId: "x", focused: true, rect: { x: 0, y: 0, width: 30, height: 40 } },
    { paneId: "y", focused: false, rect: { x: 30, y: 0, width: 30, height: 40 } },
    { paneId: "z", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
  ] };
  expect(directionalPanes(columns, "x", "right")).toEqual(["y", "z"]);
  expect(herdrNeighbor(columns, "x", "right")).toBe("y");
  expect(herdrNeighbor(layout, "a", "left")).toBeNull();
  expect(herdrNeighbor({ ...layout, zoomed: true }, "a", "right")).toBeNull();
});
test("resize axes and swap boundaries are constrained by the current layout", () => {
  // Resize names an axis; the pane needs a divider on it, on either side.
  expect(layoutActionReason(model("a"), { kind: "resize", direction: "right" })).toBe("");
  expect(layoutActionReason(model("a"), { kind: "resize", direction: "left" })).toBe("");
  expect(layoutActionReason(model("a"), { kind: "resize", direction: "up" })).not.toBe("");
  expect(layoutActionReason(model("b"), { kind: "resize", direction: "up" })).toBe("");
  expect(layoutActionReason(model("b"), { kind: "resize", direction: "right" })).toBe("");
  expect(layoutActionReason(model("b"), { kind: "swap", direction: "right" })).not.toBe("");
  expect(layoutActionReason(model("b", { disabledReason: "busy" }), { kind: "swap", direction: "left" })).toBe("busy");
});

test("a pane's position is named from where it sits on the computer screen", () => {
  expect(panePosition(layout, "a")).toBe("左侧");
  expect(panePosition(layout, "b")).toBe("右上");
  expect(panePosition(layout, "c")).toBe("右下");
  expect(panePosition({ ...layout, zoomed: true }, "a")).toBe("整屏");
});
