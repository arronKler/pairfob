import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { setLang, t } from "../../../lib/i18n";
import type { TabLayout } from "../../../lib/layout";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { boardCanvasModel, type BoardCanvasModel } from "../model/board-view";
import { BoardCanvasView, type BoardCanvasController } from "./board-canvas";

function layout(panes: Array<{ paneId: string; rect: { x: number; y: number; width: number; height: number } }>,
  extra: Partial<TabLayout> = {}): TabLayout {
  return {
    workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: panes[0]?.paneId ?? "",
    area: { x: 0, y: 0, width: 100, height: 40 },
    panes: panes.map((pane) => ({ paneId: pane.paneId, focused: pane.paneId === extra.focusedPaneId, rect: pane.rect })),
    ...extra,
  };
}

function agent(id: string, extra: Partial<DashboardAgentCard> = {}): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "claude", hasAgent: true, status: "idle",
    workspaceId: "w1", workspaceLabel: "alpha", tabId: "w1:t1", cwd: "/tmp/a", ...extra,
  };
}

const oneTab = layout([{ paneId: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 40 } }]);
const splitTab = layout([
  { paneId: "w1:p1", rect: { x: 0, y: 0, width: 60, height: 40 } },
  { paneId: "w1:p2", rect: { x: 60, y: 0, width: 40, height: 40 } },
]);

function canvas(layoutValue: TabLayout | null, agents: DashboardAgentCard[] = [agent("w1:p1")]): BoardCanvasModel {
  return boardCanvasModel({
    workspaceList: [], tabList: [], agents, layouts: layoutValue ? [layoutValue] : [],
    workspaceId: "w1", tabId: layoutValue?.tabId ?? "", selectedPaneId: "",
    status: { tone: "live", text: "" }, canCreateTab: false, operationBusy: false, connected: true,
  });
}

type Host = { viewport: HTMLElement | null; stage: HTMLElement | null; layout: TabLayout | null };

function harness(id = "") {
  const calls: string[] = [];
  const hosts: Host[] = [];
  const boundLayouts: TabLayout[] = [];
  let bound = 0;
  let disposed = 0;
  const controller: BoardCanvasController = {
    applyTransform: (stage) => calls.push(`transform${id}:${stage.className}`),
    bindGestures: (viewport, stage, layout) => {
      bound += 1;
      boundLayouts.push(layout);
      calls.push(`bind${id}:${viewport.className}:${stage.className}:${layout.area.width}`);
      return () => {
        disposed += 1;
        calls.push(`unbind${id}`);
      };
    },
    registerHost: (viewport, stage, layout) => hosts.push({ viewport, stage, layout }),
    releaseHost: () => calls.push(`releaseHost${id}`),
    openPane: (paneId, tile) => calls.push(`open:${paneId}:${tile?.dataset.paneId ?? "no-tile"}`),
    zoomAt: (_viewport, _stage, x, y, scale) => calls.push(`zoomAt:${x}:${y}:${scale}`),
    releaseScrollOnLeave: () => calls.push(`releaseScroll${id}`),
    shareTileOpening: (paneId) => calls.push(`share:${paneId}`),
  };
  return { calls, hosts, boundLayouts, controller, bound: () => bound, disposed: () => disposed };
}

function paint(model: BoardCanvasModel, controller: BoardCanvasController): void {
  act(() => renderReact(<BoardCanvasView canvas={model} controller={controller} />));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(() => {
  act(() => unmountReact());
});

describe("board canvas lifecycle", () => {
  test("the mounted canvas registers itself as the toolbar's host and releases on unmount", () => {
    const rig = harness();
    paint(canvas(oneTab), rig.controller);
    const viewport = appRoot().querySelector<HTMLElement>(".board-canvas")!;
    const stage = appRoot().querySelector<HTMLElement>(".board-stage")!;
    // The host carries the layout the canvas is displaying, for the toolbar fit.
    expect(rig.hosts.at(-1)).toEqual({ viewport, stage, layout: oneTab });
    expect(rig.hosts.length).toBeGreaterThan(0);
    act(() => unmountReact());
    expect(rig.calls).toContain("releaseHost");
  });

  test("the stage transform is repainted on every commit", () => {
    const rig = harness();
    paint(canvas(oneTab), rig.controller);
    const first = rig.calls.filter((call) => call.startsWith("transform")).length;
    paint(canvas(oneTab), rig.controller);
    expect(rig.calls.filter((call) => call.startsWith("transform")).length).toBeGreaterThan(first);
    expect(rig.disposed()).toBe(0);
    expect(rig.bound()).toBe(1);
  });

  test("gestures bind the layout the canvas displays, not another resolution", () => {
    const rig = harness();
    paint(canvas(oneTab), rig.controller);
    expect(rig.boundLayouts).toEqual([oneTab]);
    expect(rig.calls.filter((call) => call.startsWith("bind"))).toEqual([
      `bind:board-canvas:board-stage:${oneTab.area.width}`,
    ]);
  });

  test("replacing the controller retires the old binding and host and binds the new one", () => {
    const first = harness(":A");
    const second = harness(":B");
    paint(canvas(oneTab), first.controller);
    expect(first.bound()).toBe(1);
    expect(second.calls).toEqual([]);
    // Same canvas and signature, another owner: the gestures must move with it.
    paint(canvas(oneTab), second.controller);
    expect(first.disposed()).toBe(1);
    expect(first.calls).toContain("releaseHost:A");
    expect(second.bound()).toBe(1);
    expect(second.boundLayouts).toEqual([oneTab]);
    expect(second.hosts.at(-1)?.stage).toBe(appRoot().querySelector(".board-stage"));
    act(() => unmountReact());
    // Only the owner still in charge releases the host on the way out.
    expect(second.calls).toContain("releaseHost:B");
    expect(second.calls.filter((call) => call === "releaseHost:A")).toEqual([]);
  });

  test("gestures rebind when the resolved layout changes and stay bound when only titles do", () => {
    const rig = harness();
    paint(canvas(oneTab), rig.controller);
    expect(rig.bound()).toBe(1);
    // Same layout, another agent label: no rebind, no lost binding.
    paint(canvas(oneTab, [agent("w1:p1", { paneLabel: "renamed" })]), rig.controller);
    expect(rig.bound()).toBe(1);
    expect(rig.disposed()).toBe(0);
    expect(appRoot().querySelector(".board-pane-name")?.textContent).toBe("renamed");
    // A different resolved layout retires the old binding and binds the new one.
    paint(canvas(splitTab, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    expect(rig.bound()).toBe(2);
    expect(rig.disposed()).toBe(1);
    expect(appRoot().querySelectorAll(".board-pane")).toHaveLength(2);
  });

  test("a tab that loses its layout retires the binding and keeps the viewport node", () => {
    const rig = harness();
    paint(canvas(oneTab), rig.controller);
    const viewport = appRoot().querySelector(".board-canvas");
    paint(canvas(null, []), rig.controller);
    expect(appRoot().querySelector(".board-canvas")).toBe(viewport);
    expect(appRoot().querySelector(".board-stage")).toBeNull();
    expect(appRoot().querySelector(".board-canvas .empty-title")?.textContent).toBe(t("board.emptyTitle"));
    expect(rig.disposed()).toBe(1);
    expect(rig.bound()).toBe(1);
    expect(rig.hosts.at(-1)).toEqual({ viewport, stage: null, layout: null });
  });

  test("a tile click opens its pane and a double click zooms to fill instead", () => {
    const rig = harness();
    paint(canvas(splitTab, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    const tile = appRoot().querySelector<HTMLButtonElement>(".board-pane")!;
    act(() => tile.click());
    expect(rig.calls.filter((call) => call.startsWith("open"))).toEqual(["open:w1:p1:w1:p1"]);
    act(() => tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    const zoom = rig.calls.filter((call) => call.startsWith("zoomAt"));
    expect(zoom).toHaveLength(1);
    // happy-dom reports zero rectangles: the fill is the viewport's own ratio.
    expect(zoom[0]).toBe("zoomAt:0:0:0");
    expect(rig.calls.filter((call) => call.startsWith("open"))).toHaveLength(1);
  });

  test("every tile is offered the shared opening transition on each commit", () => {
    const rig = harness();
    paint(canvas(splitTab, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    expect(rig.calls.filter((call) => call.startsWith("share"))).toEqual(["share:w1:p1", "share:w1:p2"]);
  });

  test("the tile keeps pane identity, status pill and preview cell size", () => {
    const rig = harness();
    paint(canvas(splitTab, [agent("w1:p1", { status: "working" }), agent("w1:p2")]), rig.controller);
    const tiles = [...appRoot().querySelectorAll<HTMLElement>(".board-pane")];
    expect(tiles.map((tile) => tile.dataset.paneId)).toEqual(["w1:p1", "w1:p2"]);
    expect(tiles[0].className).toBe("board-pane status-working focused");
    expect(tiles[0].querySelector(".pill-working")?.textContent).toBe(t("status.working"));
    expect(tiles[0].getAttribute("aria-label")).toBe(t("board.paneAria", { title: "w1:p1" }));
    expect(tiles[0].style.width).toBe("480px");
    expect(tiles[1].style.left).toBe("480px");
    expect(appRoot().querySelectorAll(".board-pane-screen")).toHaveLength(2);
    expect(appRoot().querySelector(".board-stage")?.getAttribute("style")).toContain("width: 800px");
  });
});
