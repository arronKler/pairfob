import { resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { TabLayout } from "../../lib/layout";
import type { LiveSession } from "../../lib/protocol/session-types";
import { guidedScrollController } from "../../features/session/guided/guided-scroll";
import { morphingPane, nextTransition, queuedKind, takeTransition } from "../../app/transition";
import { appHost, type AppHost } from "../../app/host";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { boardStore, focusBoard, resetBoardCatalog, setBoardCamera, setBoardReturn } from "../../features/board/layout-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setPhase, setNetworkOnline } from "../../features/connection/connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { openPaneId, resetPaneView, selectPane } from "../../features/session/session-store";
import { clearNotice } from "../../app/notices-store";
import { appRoot } from "../../app/dom-root";
import { boardCamera } from "../../features/board/model/camera";
import {
  applyBoardTransform,
  boardCanvasController,
  fitCurrentBoard,
  nudgeBoardZoom,
  openBoardPane,
  placeBoardStage,
  presentBoardView,
  readBoardCamera,
  registerBoardCanvasHost,
  releaseBoardCanvasHost,
  writeBoardCamera,
  zoomBoardAt,
} from "./board-bridge";

const layout: TabLayout = {
  workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "w1:p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};

/** The catalog the projection tests render: two alpha workspaces, one pane. */
const snapshot = {
  focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
  workspaces: [
    { workspace_id: "w1", label: "alpha" },
    { workspace_id: "w2", label: "alpha" },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "logs" },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
  ],
  layouts: [
    {
      workspace_id: "w1",
      tab_id: "w1:t1",
      zoomed: false,
      focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 100, height: 40 },
      panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }],
    },
  ],
};

/** A snapshot whose record resolves a twice-as-wide tab than the one shown. */
const widerSnapshot = {
  focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
  workspaces: [
    { workspace_id: "w1", label: "alpha" },
    { workspace_id: "w2", label: "alpha" },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "logs" },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
  ],
  layouts: [
    {
      workspace_id: "w1",
      tab_id: "w1:t1",
      zoomed: false,
      focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 200, height: 40 },
      panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 200, height: 40 } }],
    },
  ],
};

/** Two panes in the same tab: the split-count tab label falls back to size. */
const splitSnapshot = {
  focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
  workspaces: [
    { workspace_id: "w1", label: "alpha" },
    { workspace_id: "w2", label: "alpha" },
  ],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
    { tab_id: "w1:t2", workspace_id: "w1", label: "logs" },
  ],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "codex", agent_status: "working", label: "two" },
  ],
  layouts: [
    {
      workspace_id: "w1",
      tab_id: "w1:t1",
      zoomed: false,
      focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 100, height: 40 },
      panes: [
        { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
        { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
      ],
    },
  ],
};

let disposed = 0;
const originalDispose = guidedScrollController.dispose.bind(guidedScrollController);

/** Count real App host commits/requests (captured refs, restored at teardown). */
let committed = 0;
let requested = 0;
let hostRef: AppHost | null = null;
let realCommit: AppHost["commit"] | null = null;
let realRequestCommit: AppHost["requestCommit"] | null = null;

function watchHostCommits(): void {
  hostRef = appHost();
  committed = 0;
  requested = 0;
  realCommit = hostRef!.commit;
  realRequestCommit = hostRef!.requestCommit;
  hostRef!.commit = (options) => {
    committed += 1;
    realCommit!(options);
  };
  hostRef!.requestCommit = () => {
    requested += 1;
    realRequestCommit!();
  };
}

function restoreHostCommits(): void {
  if (!hostRef) return;
  if (realCommit) hostRef.commit = realCommit;
  if (realRequestCommit) hostRef.requestCommit = realRequestCommit;
  hostRef = null;
  realCommit = null;
  realRequestCommit = null;
}

function sizedViewport(width: number, height: number): HTMLDivElement {
  const viewport = document.createElement("div");
  viewport.className = "board-canvas";
  Object.defineProperty(viewport, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(viewport, "clientHeight", { value: height, configurable: true });
  document.body.append(viewport);
  return viewport;
}

function stage(): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "board-stage";
  document.body.append(node);
  return node;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  disposed = 0;
  // The openPane continuation (focusCompose) resolves #app; bind the real
  // DOM anchor here (as the legacy suite did through its state-facade import)
  // so resetTestDOM reconnects it for every headless bridge test.
  appRoot();
  // Explicit baseline, matching the legacy fixture (never inherited from a
  // previous case): a closed pane, no board return path, no in-flight operation.
  selectPane("");
  setBoardReturn(false);
  setOperationBusy(false);
  setPhase("live");
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  resetPaneView();
  setNetworkOnline(true);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []);
  attachLiveSession({ isConnected: () => true, paneRead: async () => ({ text: "", hash: "" }) } as unknown as LiveSession);
  setScreen("board");
  replaceAgentsFromSnapshot(snapshot);
  // The legacy baseline set boardWorkspaceId/boardTabId = w1/w1:t1 explicitly;
  // fold the seed onto that focus rather than keeping whatever a prior case
  // left on a still-valid workspace/tab.
  focusBoard("w1", "w1:t1");
  setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
  guidedScrollController.dispose = () => {
    disposed += 1;
  };
  nextTransition("fade");
  takeTransition();
});

afterEach(() => {
  restoreHostCommits();
  releaseBoardCanvasHost();
  guidedScrollController.dispose = originalDispose;
  takeTransition();
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    setOperationBusy(false);
    clearNotice();
    setScreen("home");
  });
  unmountTestApp();
  document.body.replaceChildren();
});

describe("board camera bridge", () => {
  test("the camera round-trips through the record the canvas adapter writes", () => {
    writeBoardCamera(boardCamera(1.5, -20, 30, false));
    expect(readBoardCamera()).toEqual({ scale: 1.5, panX: -20, panY: 30, fitted: false });
    expect([boardStore.get().boardScale, boardStore.get().boardPanX, boardStore.get().boardPanY, boardStore.get().boardFitted])
      .toEqual([1.5, -20, 30, false]);
    const node = stage();
    applyBoardTransform(node);
    expect(node.style.transform).toBe("translate(-20px, 30px) scale(1.5)");
  });

  test("the toolbar reaches the canvas through the registered host, never a document hunt", () => {
    const viewport = sizedViewport(400, 300);
    const node = stage();
    setBoardCamera({ scale: 1, panX: 0, panY: 0 }, false);
    // Without a mounted canvas there is nothing to fit and nothing is written.
    fitCurrentBoard();
    expect(readBoardCamera()).toEqual({ scale: 1, panX: 0, panY: 0, fitted: false });

    registerBoardCanvasHost(viewport, node, layout);
    fitCurrentBoard();
    expect(readBoardCamera().fitted).toBe(true);
    expect(readBoardCamera().scale).toBeCloseTo(260 / 640, 6);
    expect(node.style.transform).toBe("translate(37.5px, 20px) scale(0.40625)");

    nudgeBoardZoom(1);
    expect(readBoardCamera().scale).toBeCloseTo((260 / 640) * 1.2, 6);
    nudgeBoardZoom(-1);
    expect(readBoardCamera().scale).toBeCloseTo(260 / 640, 6);

    releaseBoardCanvasHost();
    setBoardCamera({ scale: 1, panX: 0, panY: 0 }, false);
    fitCurrentBoard();
    expect(readBoardCamera().fitted).toBe(false);
  });

  test("the toolbar fits the layout the canvas registered, not the record's", () => {
    const viewport = sizedViewport(800, 600);
    const node = stage();
    // The record resolves a twice-as-wide tab than the board on screen.
    act(() => replaceAgentsFromSnapshot(widerSnapshot));
    setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
    registerBoardCanvasHost(viewport, node, layout);
    fitCurrentBoard();
    expect(readBoardCamera().scale).toBeCloseTo(0.875, 6);
    expect(readBoardCamera().scale).not.toBeCloseTo(0.475, 6);
    releaseBoardCanvasHost();
  });

  test("placing and zooming write the record and paint the stage in one step", () => {
    const viewport = sizedViewport(800, 600);
    const node = stage();
    placeBoardStage(viewport, node, layout);
    expect(boardStore.get().boardFitted).toBe(true);
    expect(node.style.transform).toContain("scale(0.875)");
    zoomBoardAt(viewport, node, 400, 300, 2);
    expect(readBoardCamera().scale).toBe(2);
    expect(node.style.transform).toContain("scale(2)");
    // A clamped zoom neither writes nor repaints.
    const before = readBoardCamera();
    const transform = node.style.transform;
    zoomBoardAt(viewport, node, 400, 300, 2);
    expect(readBoardCamera()).toEqual(before);
    expect(node.style.transform).toBe(transform);
  });
});

describe("board canvas controller", () => {
  test("the transform comes from the record on every commit", () => {
    const node = stage();
    writeBoardCamera(boardCamera(2, 4, 5, true));
    boardCanvasController.applyTransform(node);
    expect(node.style.transform).toBe("translate(4px, 5px) scale(2)");
  });

  test("binding takes the displayed layout and returns its disposer", () => {
    const viewport = sizedViewport(400, 300);
    const node = stage();
    const stop = boardCanvasController.bindGestures(viewport, node, layout);
    expect(typeof stop).toBe("function");
    expect(node.style.transform).toBe("translate(0px, 0px) scale(1)");
    stop();
  });

  test("opening a tile marks the return path and shares the expansion", async () => {
    const tile = document.createElement("button");
    tile.className = "board-pane";
    document.body.append(tile);
    openBoardPane("w1:p1", tile);
    expect(boardStore.get().boardReturn).toBe(true);
    expect(queuedKind()).toBe("expand");
    expect(morphingPane()).toBe("w1:p1");
    expect(tile.style.getPropertyValue("view-transition-name")).toBe("pane-open");
    expect(currentScreen()).toBe("pane");
    expect(openPaneId()).toBe("w1:p1");
    takeTransition();
    // An empty pane id opens nothing and invents no transition.
    nextTransition("fade");
    takeTransition();
    setScreen("board");
    openBoardPane("");
    expect(queuedKind()).toBe("none");
    expect(currentScreen()).toBe("board");
    expect(openPaneId()).toBe("w1:p1");
  });

  test("a tile only shares its opening for the pane that is actually expanding", () => {
    const tile = document.createElement("button");
    document.body.append(tile);
    boardCanvasController.shareTileOpening("w1:p1", tile);
    expect(tile.style.getPropertyValue("view-transition-name")).toBe("");
    nextTransition("push", "w1:p1");
    boardCanvasController.shareTileOpening("w1:p1", tile);
    expect(tile.style.getPropertyValue("view-transition-name")).toBe("");
    nextTransition("expand", "w1:p1");
    boardCanvasController.shareTileOpening("w1:p1", tile);
    expect(tile.style.getPropertyValue("view-transition-name")).toBe("pane-open");
    // Another pane is not the one expanding: the shared name is left alone.
    boardCanvasController.shareTileOpening("w1:p2", tile);
    expect(tile.style.getPropertyValue("view-transition-name")).toBe("pane-open");
    takeTransition();
  });

  test("the remote scroll is released only when the board was really left", () => {
    boardCanvasController.releaseScrollOnLeave();
    expect(disposed).toBe(0);
    setScreen("pane");
    boardCanvasController.releaseScrollOnLeave();
    expect(disposed).toBe(1);
  });

  test("zooming through the controller lands on the record and the stage", () => {
    const viewport = sizedViewport(400, 300);
    const node = stage();
    boardCanvasController.zoomAt(viewport, node, 200, 150, 3);
    expect(readBoardCamera().scale).toBe(3);
    expect(node.style.transform).toContain("scale(3)");
  });
});

describe("board projection bridge", () => {
  test("presenting reads the record and changes nothing", () => {
    // The real App host is mounted so the no-repaint contract is observed
    // through this host's commit/requestCommit, not a synthetic renderer.
    mountTestApp();
    commitTest();
    watchHostCommits();
    const before = JSON.stringify([boardStore.get().boardWorkspaceId, boardStore.get().boardTabId, boardStore.get().boardScale, boardStore.get().boardFitted]);
    const view = presentBoardView();
    expect(JSON.stringify([boardStore.get().boardWorkspaceId, boardStore.get().boardTabId, boardStore.get().boardScale, boardStore.get().boardFitted])).toBe(before);
    expect(view.title).toBe(t("board.title"));
    expect(view.spaces.map((space) => space.label)).toEqual(["alpha · tmp/a", "alpha"]);
    expect(view.tabs.map((tab) => tab.label)).toEqual([t("board.tabIndex", { n: 1 }), "logs"]);
    expect(view.create).toEqual({ label: t("board.newTab"), disabled: false });
    expect(view.canvas.tiles.map((tile) => tile.paneId)).toEqual(["w1:p1"]);
    // A pure projection: no extra App commit and no queued commit request.
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });

  test("capability and connection gates fail closed", () => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    expect(presentBoardView().create).toBeNull();
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []);
    setOperationBusy(true);
    expect(presentBoardView().create?.disabled).toBe(true);
    setOperationBusy(false);
    attachLiveSession({ isConnected: () => false } as unknown as LiveSession);
    expect(presentBoardView().create?.disabled).toBe(true);
    attachLiveSession(null);
    expect(presentBoardView().create?.disabled).toBe(true);
  });

  test("the projected labels come from the catalog and the herd, not the caller", () => {
    // Duplicate workspace names keep a folder tail; a hidden tab label falls back.
    expect(presentBoardView().spaces.map((space) => space.label)).toEqual(["alpha · tmp/a", "alpha"]);
    expect(presentBoardView().tabs.map((tab) => tab.label)).toEqual([t("board.tabIndex", { n: 1 }), "logs"]);
    act(() => replaceAgentsFromSnapshot(splitSnapshot));
    expect(presentBoardView().tabs[0].label).toBe(t("detail.splitCount", { n: 2 }));
  });
});