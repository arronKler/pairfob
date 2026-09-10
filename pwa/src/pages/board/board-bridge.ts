/**
 * Board page bridge.
 *
 * Writes go through the approved domain actions (`app/state/board`,
 * `app/state/navigation`), so a mounted board updates from its own subscriptions
 * without a manual repaint: selecting a workspace or a tab publishes and the page
 * re-renders, and the camera publishes without being part of what the page
 * renders (see the scoped watch in `pages/board/index.tsx`).
 *
 * Reads come from the domain snapshots and the domains' live readers. Action-time
 * decisions read the named canonical getters, which see a typed write the moment
 * it lands; React projections read the stable published snapshots. There is no
 * page-level flush: the App commit pipeline (`app/commit.ts`) owns publication.
 *
 * Entering and leaving the board is a real navigation: `goToScreen` stages it and
 * the existing synchronous controller boundary `commitView()` commits the
 * arriving shell — `#app` classes, the scroll lock and the terminal CSS vars —
 * before the call returns, so the board is on the page when preview and scroll
 * ownership start. In-screen updates never commit here.
 *
 * Presentation (`features/board`) and the pure models never import this file.
 */
import {
  boardStore,
  focusBoard,
  liveBoardCamera,
  liveBoardCatalog,
  selectBoardTab,
  selectBoardWorkspace,
  setBoardCamera,
  setBoardReturn,
} from "../../features/board/layout-store";
import { capabilityEnabled, operationBusy } from "../../features/operations/capabilities-store";
import { liveSession } from "../../features/computers/catalog-store";
import { networkOnline } from "../../features/connection/connection-store";
import { dashboardStore, liveAgents, selectedAgent } from "../../features/dashboard/catalog-store";
import { commitView } from "../../app/host";
import { currentScreen, goToScreen } from "../../app/navigation-store";
import { runtimeStore } from "../../features/connection/runtime-store";
import { isAgentChat, isFullTerminal, openPaneId } from "../../features/session/session-store";
import { parkComposeView } from "../../features/session/drafts/compose-drafts";
import {
  buildBoardViewModel,
  boardTabAnchor,
  firstTabInWorkspace,
  type BoardModelInput,
  type BoardViewModel,
} from "../../features/board/model/board-view";
import { boardCamera, type BoardCamera } from "../../features/board/model/camera";
import { bindBoardCanvasGestures, type BoardCanvasPorts } from "../../features/board/canvas/gesture-adapter";
import {
  applyCameraTransform,
  fitCameraToViewport,
  viewportCenter,
  zoomCameraAtPoint,
} from "../../features/board/canvas/transform";
import type { BoardCanvasController } from "../../features/board/components/board-canvas";
import type { BoardScreenActions } from "../../features/board/components/board-screen";
import type { DashboardAgentCard } from "../../lib/dashboard";
import type { BoardSpace, BoardTab, TabLayout } from "../../lib/layout";
import { openPane, wakeLiveReads } from "../../features/connection/controller";
import { createSelectedTab } from "../../features/operations/controller";
import { leaveAgentChat } from "../../features/session/chat/agent-chat-controller";
import { leaveFullTerminal } from "../../features/session/full-terminal/full-terminal";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { focusCompose } from "../../features/session/guided/compose";
import { morphingPane, nextTransition, queuedKind, shareOpening } from "../../app/transition";
import { herdLivenessModel, herdStatusModel } from "../../features/dashboard/model/herd-status";
import { releaseBoardScroll, schedulePanePreview, scrollBoardPane } from "./pane-scroll";
import { refreshBoardPreviews } from "../../features/board/preview/refresh";

const NUDGE_ZOOM_FACTOR = 1.2;

/**
 * Published snapshots are deep-frozen and the projections only read them; the
 * layout and label libs still declare mutable arrays, so the frozen catalog is
 * handed over as one at this single boundary.
 */
function publishedCatalog() {
  const board = boardStore.get();
  return {
    layouts: board.layouts as TabLayout[],
    workspaceList: board.workspaceList as BoardSpace[],
    tabList: board.tabList as BoardTab[],
    workspaceId: board.boardWorkspaceId,
    tabId: board.boardTabId,
  };
}

/**
 * The live catalog for action-time entry and selection decisions. Reads the
 * owner record, so a typed focus or catalog action is visible immediately even
 * while a composition transaction holds publication; the arrays are detached
 * because the layout/label libs declare mutable ones.
 */
function liveCatalog() {
  const catalog = liveBoardCatalog();
  return {
    layouts: catalog.layouts as TabLayout[],
    workspaceList: catalog.workspaceList as BoardSpace[],
    tabList: catalog.tabList as BoardTab[],
    workspaceId: catalog.workspaceId,
    tabId: catalog.tabId,
  };
}

function publishedAgents(): DashboardAgentCard[] {
  return dashboardStore.get().agents as DashboardAgentCard[];
}

export function readBoardInput(): BoardModelInput {
  const catalog = publishedCatalog();
  const runtime = runtimeStore.get();
  const connected = liveSession()?.isConnected() === true;
  const online = networkOnline();
  return {
    workspaceList: catalog.workspaceList,
    tabList: catalog.tabList,
    agents: publishedAgents(),
    layouts: catalog.layouts,
    workspaceId: catalog.workspaceId,
    tabId: catalog.tabId,
    selectedPaneId: openPaneId(),
    status: herdStatusModel({
      connected,
      networkOnline: online,
      runtimeKind: runtime.runtimeKind,
      herdHost: runtime.herdHost,
      liveness: herdLivenessModel({ connected, networkOnline: online, runtimeKind: runtime.runtimeKind }),
    }),
    canCreateTab: capabilityEnabled("create_tab"),
    operationBusy: operationBusy(),
    connected,
  };
}

/**
 * Present the board from an imperative boundary. Pure projection of the domains'
 * live readers and published snapshots; it mutates nothing. Production frame
 * preparation invokes this before mounting the board route. Never call this from
 * a React render: `BoardPage` projects with `readBoardInput` instead.
 */
export function presentBoardView(): BoardViewModel {
  return buildBoardViewModel(readBoardInput());
}

/**
 * The camera as the gesture/toolbar path reads it at pointer speed. This is the
 * live owner record, not the published snapshot, so it sees a camera write the
 * moment it lands; it never publishes. The presentation and toolbar actions are
 * the commit points that make a pending write visible before a camera read starts.
 */
export function readBoardCamera(): BoardCamera {
  const camera = liveBoardCamera();
  return boardCamera(camera.scale, camera.panX, camera.panY, camera.fitted);
}

export function writeBoardCamera(camera: BoardCamera): void {
  setBoardCamera({ scale: camera.scale, panX: camera.panX, panY: camera.panY }, camera.fitted);
}

/**
 * The mounted canvas registers itself so the toolbar can reach it — together
 * with the layout it is displaying, so a fit measures the board on screen rather
 * than whatever the record resolves to a moment later.
 */
const host: { viewport: HTMLElement | null; stage: HTMLElement | null; layout: TabLayout | null } = {
  viewport: null,
  stage: null,
  layout: null,
};

export function registerBoardCanvasHost(
  viewport: HTMLElement | null,
  stage: HTMLElement | null,
  layout: TabLayout | null,
): void {
  host.viewport = viewport;
  host.stage = stage;
  host.layout = layout;
}

export function releaseBoardCanvasHost(): void {
  host.viewport = null;
  host.stage = null;
  host.layout = null;
}

export function applyBoardTransform(stage: HTMLElement): void {
  applyCameraTransform(stage, readBoardCamera());
}

export function placeBoardStage(viewport: HTMLElement, stage: HTMLElement, layout: TabLayout): void {
  const fitted = fitCameraToViewport(viewport, layout);
  writeBoardCamera(fitted);
  applyCameraTransform(stage, fitted);
}

export function zoomBoardAt(
  viewport: HTMLElement,
  stage: HTMLElement,
  clientX: number,
  clientY: number,
  nextScale: number,
): void {
  const next = zoomCameraAtPoint(readBoardCamera(), viewport, clientX, clientY, nextScale);
  if (!next) return;
  writeBoardCamera(next);
  applyCameraTransform(stage, next);
}

export function fitCurrentBoard(): void {
  if (!host.viewport || !host.stage || !host.layout) return;
  placeBoardStage(host.viewport, host.stage, host.layout);
}

export function nudgeBoardZoom(direction: 1 | -1): void {
  if (!host.viewport || !host.stage) return;
  const center = viewportCenter(host.viewport);
  const factor = direction > 0 ? NUDGE_ZOOM_FACTOR : 1 / NUDGE_ZOOM_FACTOR;
  zoomBoardAt(host.viewport, host.stage, center.x, center.y, readBoardCamera().scale * factor);
}

export function openBoardPane(paneId: string, tile?: HTMLElement): void {
  if (!paneId) return;
  setBoardReturn(true);
  // The tile is the same object as the pane about to fill the screen, so it
  // expands into it instead of the screen sliding in from the side.
  shareOpening(tile);
  nextTransition("expand", paneId);
  void openPane(paneId).then(() => {
    focusCompose();
    if (!document.querySelector(".full-terminal-compose-input, .dock-form textarea")) {
      requestAnimationFrame(() => focusCompose());
    }
  });
}

function canvasPorts(): BoardCanvasPorts {
  return {
    readCamera: readBoardCamera,
    writeCamera: writeBoardCamera,
    scrollPane: (layout, paneId, direction, lines) => scrollBoardPane(layout, paneId, direction, lines),
    requestPanePreview: schedulePanePreview,
    openPane: (paneId, tile) => openBoardPane(paneId, tile),
  };
}

export function createBoardCanvasController(): BoardCanvasController {
  return {
    applyTransform(stage) {
      applyBoardTransform(stage);
    },
    bindGestures(viewport, stage, layout) {
      return bindBoardCanvasGestures(viewport, stage, layout, canvasPorts());
    },
    registerHost(viewport, stage, layout) {
      registerBoardCanvasHost(viewport, stage, layout);
    },
    releaseHost() {
      releaseBoardCanvasHost();
    },
    openPane(paneId, tile) {
      openBoardPane(paneId, tile || undefined);
    },
    zoomAt(viewport, stage, clientX, clientY, nextScale) {
      zoomBoardAt(viewport, stage, clientX, clientY, nextScale);
    },
    releaseScrollOnLeave() {
      if (currentScreen() !== "board") releaseBoardScroll();
    },
    shareTileOpening(paneId, tile) {
      if (queuedKind() === "expand" && morphingPane() === paneId) shareOpening(tile);
    },
  };
}

export async function openBoard(from?: { workspaceId?: string; tabId?: string }): Promise<void> {
  parkComposeView();
  if (isFullTerminal()) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (isAgentChat()) leaveAgentChat({ rememberGuided: false, paint: false });
  dropQueuedKeys();
  releaseBoardScroll();
  const selected = selectedAgent();
  const catalog = liveCatalog();
  focusBoard(
    from?.workspaceId || selected?.workspaceId || catalog.workspaceId,
    from?.tabId || (from?.workspaceId ? "" : selected?.tabId) || catalog.tabId,
  );
  // goToScreen stages the navigation; the synchronous controller commit owns the
  // arriving shell (#app classes, scroll lock, terminal vars) before previews and
  // scroll ownership start. Ordinary in-screen updates stay on subscriptions.
  goToScreen("board");
  commitView();
  void refreshBoardPreviews();
  wakeLiveReads();
}

export function closeBoard(): void {
  releaseBoardScroll();
  setBoardReturn(false);
  goToScreen("home");
  commitView();
}

/** In-screen selection: the page is subscribed, so publishing is the repaint. */
export function selectWorkspace(workspaceId: string): void {
  const catalog = liveCatalog();
  if (catalog.workspaceId === workspaceId) return;
  releaseBoardScroll();
  selectBoardWorkspace(workspaceId, firstTabInWorkspace(catalog.tabList, workspaceId));
  void refreshBoardPreviews();
}

export function selectTab(tabId: string): void {
  if (liveCatalog().tabId === tabId) return;
  releaseBoardScroll();
  selectBoardTab(tabId);
  void refreshBoardPreviews();
}

export function newTabInBoard(): void {
  const catalog = liveCatalog();
  const agent =
    boardTabAnchor(liveAgents() as DashboardAgentCard[], catalog.workspaceId, catalog.tabId) || selectedAgent();
  void createSelectedTab(agent);
}

export function boardScreenActions(): BoardScreenActions {
  return {
    back: closeBoard,
    selectWorkspace,
    selectTab,
    createTab: newTabInBoard,
    fit: fitCurrentBoard,
    zoom: nudgeBoardZoom,
  };
}

/** One instance each: the route and the compatibility canvas share them. */
export const boardActions = boardScreenActions();
export const boardCanvasController = createBoardCanvasController();

export { releaseBoardScroll };
