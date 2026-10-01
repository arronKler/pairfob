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
import { setLayoutDraft } from "../model/draft-store";
import { applyCameraTransform } from "../canvas/transform";
import { boardCamera } from "../model/camera";
import { publishPreview, clearBoardPreviews } from "../preview/store";

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
    layoutCaps: { resize: true, swap: true, split: true, zoom: true },
  });
}

type Host = { viewport: HTMLElement | null; stage: HTMLElement | null; layout: TabLayout | null };
let zoomReason = "";

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
    commitResize: async (request) => { calls.push(`resize:${request.pane_id}:${request.direction}`); },
    commitSwap: async (paneId, direction) => { calls.push(`swap:${paneId}:${direction}`); },
    pickSplit: (paneId, direction) => calls.push(`split:${paneId}:${direction}`),
    layoutReason: (kind) => (kind === "zoom" ? zoomReason : ""),
    openResizeSheet: (paneId) => calls.push(`resizeSheet:${paneId}`),
    toggleZoom: async (paneId, mode) => { calls.push(`zoom:${paneId}:${mode}`); },
    paneAction: (paneId, action) => calls.push(`${action}:${paneId}`),
  };
  return { calls, hosts, boundLayouts, controller, bound: () => bound, disposed: () => disposed };
}

function paint(model: BoardCanvasModel, controller: BoardCanvasController): void {
  act(() => renderReact(<BoardCanvasView canvas={model} controller={controller} />));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  zoomReason = "";
});

afterEach(() => {
  act(() => unmountReact());
  setLayoutDraft(null);
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

  test("the tile keeps pane identity, status word and preview cell size", () => {
    const rig = harness();
    paint(canvas(splitTab, [agent("w1:p1", { status: "working" }), agent("w1:p2")]), rig.controller);
    const tiles = [...appRoot().querySelectorAll<HTMLElement>(".board-pane")];
    expect(tiles.map((tile) => tile.dataset.paneId)).toEqual(["w1:p1", "w1:p2"]);
    expect(tiles[0].className).toBe("board-pane status-working focused");
    expect(tiles[0].querySelector(".board-pane-title .board-pane-word.is-working")?.textContent).toBe(t("status.working"));
    expect(tiles[0].getAttribute("aria-label")).toBe(t("board.paneAria", { title: "w1:p1" }));
    expect(tiles[0].style.width).toBe("480px");
    expect(tiles[1].style.left).toBe("480px");
    expect(appRoot().querySelectorAll(".board-pane-screen")).toHaveLength(2);
    expect(appRoot().querySelector(".board-stage")?.getAttribute("style")).toContain("width: 800px");
  });

  test("the title bar carries mark, status dot, name, status word and the in-bar ⋯", () => {
    const rig = harness();
    paint(canvas(splitTab, [agent("w1:p1", { status: "blocked" }), agent("w1:p2", { hasAgent: false, agent: "" })]), rig.controller);
    const [agentTile, shellTile] = [...appRoot().querySelectorAll<HTMLElement>(".board-pane")];
    const bar = agentTile.querySelector(".board-pane-title")!;
    expect(bar.querySelector(".agent-avatar")).not.toBeNull();
    expect(bar.querySelector(".board-pane-dot.is-blocked")).not.toBeNull();
    expect(bar.querySelector(".board-pane-more")?.getAttribute("aria-label")).toBe(t("boardMenu.more", { title: "w1:p1" }));
    // A plain terminal shows its name in mono, with no agent state at all.
    const shellBar = shellTile.querySelector(".board-pane-title")!;
    expect(shellBar.querySelector(".board-pane-name.is-terminal")).not.toBeNull();
    expect(shellBar.querySelector(".board-pane-dot, .board-pane-word")).toBeNull();
    act(() => bar.querySelector<HTMLButtonElement>(".board-pane-more")!.click());
    expect(rig.calls.filter((call) => call.startsWith("open"))).toEqual([]);
  });

  test("at any zoom a tile shows its real screen, scaled with the stage, never a stand-in", () => {
    clearBoardPreviews();
    publishPreview("w1:p1", { text: "one\ntwo\nthree", hash: "h" });
    const rig = harness();
    paint(canvas(oneTab), rig.controller);
    const stage = appRoot().querySelector<HTMLElement>(".board-stage")!;
    for (const scale of [1, 0.25, 0.12]) {
      applyCameraTransform(stage, boardCamera(scale, 0, 0, false));
      // The screen lives inside the stage, so the camera's scale is what shrinks it.
      expect(stage.style.transform).toContain(`scale(${scale})`);
      const screen = stage.querySelector<HTMLElement>(".board-pane .board-pane-screen")!;
      expect(screen.textContent).toContain("three");
      expect(stage.querySelector(".board-pane-card, .board-pane-mark, [data-level]")).toBeNull();
    }
    clearBoardPreviews();
  });

  test("a zoomed tab draws the zoomed pane alone and offers the way back", () => {
    const rig = harness();
    const zoomed = { ...splitTab, zoomed: true, focusedPaneId: "w1:p2" };
    paint(canvas(zoomed, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    const tiles = [...appRoot().querySelectorAll<HTMLElement>(".board-pane")];
    expect(tiles.map((tile) => [tile.dataset.paneId, tile.style.width])).toEqual([["w1:p2", "800px"]]);
    const banner = appRoot().querySelector(".board-zoom-banner")!;
    // Presses on it must reach its button, not start a canvas gesture.
    expect(banner.hasAttribute("data-board-overlay")).toBeTrue();
    expect(banner.textContent).toContain(t("boardCanvas.zoomedBanner"));
    act(() => banner.querySelector<HTMLButtonElement>("button")!.click());
    expect(rig.calls).toContain("zoom:w1:p2:off");
    zoomReason = t("boardMenu.offline");
    paint(canvas(zoomed, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    expect(appRoot().querySelector<HTMLButtonElement>(".board-zoom-banner button")!.disabled).toBeTrue();
    paint(canvas(splitTab, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    expect(appRoot().querySelector(".board-zoom-banner")).toBeNull();
  });

  test("a divider draft re-lays the tiles live and leaves the bound layout alone", () => {
    const rig = harness();
    const split = { ...splitTab, splits: [{ id: "root", direction: "right" as const, ratio: 0.6, rect: splitTab.area }] };
    paint(canvas(split, [agent("w1:p1"), agent("w1:p2")]), rig.controller);
    act(() => setLayoutDraft({ tabId: "w1:t1", splitId: "root", ratio: 0.7, pending: false }));
    const tiles = [...appRoot().querySelectorAll<HTMLElement>(".board-pane")];
    expect(tiles.map((tile) => [tile.style.left, tile.style.width])).toEqual([["0px", "560px"], ["560px", "240px"]]);
    expect(rig.bound()).toBe(1);
    // Another tab's draft never moves this one.
    act(() => setLayoutDraft({ tabId: "w1:t9", splitId: "root", ratio: 0.3, pending: false }));
    expect(appRoot().querySelector<HTMLElement>(".board-pane")!.style.width).toBe("480px");
    act(() => setLayoutDraft(null));
    expect(appRoot().querySelector<HTMLElement>(".board-pane")!.style.width).toBe("480px");
  });
});
