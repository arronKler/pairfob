import { resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import type { DashboardAgentCard } from "../../lib/dashboard";
import type { TabLayout } from "../../lib/layout";
import { boardStore, focusBoard, resetBoardCatalog, setBoardCamera } from "../../features/board/layout-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { openPaneId, selectPane } from "../../features/session/session-store";
import { BoardCanvasView } from "../../features/board/components/board-canvas";
import { buildBoardViewModel } from "../../features/board/model/board-view";
import { boardCanvasController } from "./board-bridge";

function tabLayout(areaWidth: number): TabLayout {
  return {
    workspaceId: "w1",
    tabId: "w1:t1",
    zoomed: false,
    focusedPaneId: "w1:p1",
    area: { x: 0, y: 0, width: areaWidth, height: 40 },
    panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: areaWidth, height: 40 } }],
  };
}

function agent(id: string): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "claude", hasAgent: true, status: "idle",
    workspaceId: "w1", workspaceLabel: "alpha", tabId: "w1:t1", cwd: "/tmp/a",
  };
}

const displayed = tabLayout(100);
const elsewhere = tabLayout(200);

const settleFrames = () => new Promise<void>((resolve) => setTimeout(resolve, 24));

function sizedViewport(): HTMLDivElement {
  const viewport = document.createElement("div");
  viewport.className = "board-canvas";
  Object.defineProperty(viewport, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true });
  return viewport;
}

/** Fold a record whose resolved layout differs from the one being displayed. */
function seedRecord(areaWidth: number): void {
  focusBoard("w1", "w1:t1");
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [{ workspace_id: "w1", label: "alpha" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle" },
    ],
    layouts: [
      {
        workspace_id: "w1",
        tab_id: "w1:t1",
        zoomed: false,
        focused_pane_id: "w1:p1",
        area: { x: 0, y: 0, width: areaWidth, height: 40 },
        panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: areaWidth, height: 40 } }],
      },
    ],
  });
  setBoardCamera({ scale: 1, panX: 0, panY: 0 }, false);
}

function harness(bound: TabLayout | null = displayed) {
  const viewport = sizedViewport();
  const stage = document.createElement("div");
  const tile = document.createElement("button");
  tile.className = "board-pane";
  tile.dataset.paneId = "w1:p1";
  let clicks = 0;
  tile.addEventListener("click", () => {
    clicks += 1;
  });
  stage.append(tile);
  viewport.append(stage);
  document.body.append(viewport);
  // The record resolves a different tab layout than the one being displayed.
  seedRecord(200);
  const stop = bound ? boardCanvasController.bindGestures(viewport, stage, bound) : () => {};
  return { viewport, stage, tile, clicks: () => clicks, stop };
}

function tap(viewport: HTMLElement): void {
  const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 4, clientY: 4 });
  const up = new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 4, clientY: 4 });
  viewport.dispatchEvent(down);
  viewport.dispatchEvent(up);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  // The component fixture renders into the same #app anchor; bind it here so
  // resetTestDOM reconnects it for every case.
  appRoot();
});

afterEach(() => {
  act(() => unmountReact());
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    // The original afterEach cleared the open pane id explicitly; the dashboard
    // and board resets do not.
    selectPane("");
    setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
    setScreen("home");
  });
  document.body.replaceChildren();
});

describe("board canvas binding through the page controller", () => {
  test("retired bindings emit no late tile clicks", () => {
    const { tile, clicks, stop } = harness();
    stop();
    tap(tile);
    expect(clicks()).toBe(0);
    tile.remove();
  });

  test("a live binding still synthesizes a tap click before cleanup", () => {
    const { tile, clicks, stop } = harness();
    tap(tile);
    expect(clicks()).toBe(1);
    stop();
    tap(tile);
    expect(clicks()).toBe(1);
    tile.remove();
  });

  test("the first fit measures the bound layout, not the one the record resolves", async () => {
    const { stage, stop } = harness(displayed);
    await settleFrames();
    // Displayed: area 100 cells -> stage 800x640 in an 800x600 viewport.
    expect(boardStore.get().boardScale).toBeCloseTo(0.875, 6);
    expect(boardStore.get().boardFitted).toBe(true);
    expect(stage.style.transform).toContain("scale(0.875)");
    stop();
  });

  test("the mounted canvas fits what it renders even after the record moves on", async () => {
    setScreen("board");
    seedRecord(200);
    const view = buildBoardViewModel({
      workspaceList: [], tabList: [], agents: [agent("w1:p1")], layouts: [displayed],
      workspaceId: "w1", tabId: "w1:t1", selectedPaneId: "", status: { tone: "live", text: "" },
      canCreateTab: false, operationBusy: false, connected: true,
    });
    renderReact(<BoardCanvasView canvas={view.canvas} controller={boardCanvasController} />);
    const viewport = appRoot().querySelector<HTMLElement>(".board-canvas")!;
    Object.defineProperty(viewport, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 600, configurable: true });
    await act(async () => {
      await settleFrames();
    });
    expect(appRoot().querySelector<HTMLElement>(".board-stage")!.style.width).toBe("800px");
    expect(boardStore.get().boardScale).toBeCloseTo(0.875, 6);
    expect(boardStore.get().boardScale).not.toBeCloseTo(0.475, 6);
  });
});