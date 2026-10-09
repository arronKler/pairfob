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
  clearBoardReturn,
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
  settleCamera,
  viewportCenter,
  zoomCameraAtPoint,
} from "../../features/board/canvas/transform";
import type { BoardCanvasController } from "../../features/board/components/board-canvas";
import type { BoardScreenActions } from "../../features/board/components/board-screen";
import type { DashboardAgentCard } from "../../lib/dashboard";
import type { BoardSpace, BoardTab, TabLayout } from "../../lib/layout";
import { openPane, wakeLiveReads } from "../../features/connection/controller";
import { openCreateSheet, openQuickCreate } from "../home/create-bridge";
import { leaveAgentChat } from "../../features/session/chat/agent-chat-controller";
import { leaveFullTerminal } from "../../features/session/full-terminal/full-terminal";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { focusCompose } from "../../features/session/guided/compose";
import { morphingPane, nextTransition, queuedKind, shareOpening } from "../../app/transition";
import { herdLivenessModel, herdStatusModel } from "../../features/dashboard/model/herd-status";
import { canCreateSession } from "../../features/dashboard/model/herd-view";
import { releaseBoardScroll, schedulePanePreview, scrollBoardPane } from "./pane-scroll";
import { refreshBoardPreviews } from "../../features/board/preview/refresh";
import { openBoardPaneMenu } from "./pane-menu";
import { boardInteractionStore, endBoardPlacement } from "../../features/board/interaction-store";
import type { SplitDirection } from "../../lib/operations";
import {
  boardLayoutReason,
  boardPaneAction,
  commitBoardResize,
  commitBoardSwap,
  toggleBoardZoom,
} from "./board-layout-ops";
import { openBoardResizeSheet } from "./resize-sheet";
import { openBoardSplitSheet } from "./split-sheet";
import { openBoardTabMenu } from "./tab-menu";

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
  const agents = publishedAgents();
  return {
    workspaceList: catalog.workspaceList,
    tabList: catalog.tabList,
    agents,
    layouts: catalog.layouts,
    workspaceId: catalog.workspaceId,
    tabId: catalog.tabId,
    selectedPaneId: openPaneId(),
    status: herdStatusModel({ checking: liveSession()?.isChecking?.() === true,
      connected,
      networkOnline: online,
      runtimeKind: runtime.runtimeKind,
      herdHost: runtime.herdHost,
      reading: runtime.identityPending,
      liveness: herdLivenessModel({ connected, networkOnline: online, runtimeKind: runtime.runtimeKind }),
    }),
    canCreateTab: capabilityEnabled("create_tab"),
    canCreateWorkspace: capabilityEnabled("create_conversation"),
    // The list's own answer to "can a session be started now", so the board's + never invites what the list refuses.
    // With no session at all the list is unknown until its first snapshot is read, and so is the empty board.
    creatable: canCreateSession({
      liveness: herdLivenessModel({ connected, networkOnline: online, runtimeKind: runtime.runtimeKind }),
      loading: agents.length ? runtime.identityPending : !dashboardStore.get().snapshotLoaded,
      operationBusy: operationBusy(),
    }),
    layoutCaps: {
      resize: capabilityEnabled("resize_pane"),
      swap: capabilityEnabled("swap_pane"),
      split: capabilityEnabled("split_pane"),
      zoom: capabilityEnabled("zoom_pane"),
    },
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
  settleCamera(stage, fitCameraToViewport(viewport, layout), writeBoardCamera);
}

export function zoomBoardAt(
  viewport: HTMLElement,
  stage: HTMLElement,
  clientX: number,
  clientY: number,
  nextScale: number,
): void {
  const next = zoomCameraAtPoint(readBoardCamera(), viewport, clientX, clientY, nextScale);
  if (next) settleCamera(stage, next, writeBoardCamera);
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

/** The fit the camera was last checked against; it belongs to the camera, not to one mounted canvas. */
let fitSeen: BoardCamera | null = null;

function canvasPorts(): BoardCanvasPorts {
  return {
    readCamera: readBoardCamera,
    writeCamera: writeBoardCamera,
    readFit: () => fitSeen,
    writeFit: (fit) => { fitSeen = fit; },
    scrollPane: (layout, paneId, direction, lines) => scrollBoardPane(layout, paneId, direction, lines),
    requestPanePreview: schedulePanePreview,
    openPane: (paneId, tile) => openBoardPane(paneId, tile),
    openMenu: showBoardPaneMenu,
    // A long press lifts the tile; dropping it on a neighbour swaps them.
    commitSwap: commitBoardSwap,
    swapReason: () => boardLayoutReason("swap"),
    placementActive: () => !!boardInteractionStore.get().placementKind,
    endPlacement: endBoardPlacement,
  };
}

function showBoardPaneMenu(paneId: string, point: { x: number; y: number }, tile: HTMLElement): void {
  void openBoardPaneMenu(paneId, point, tile, { openPane: openBoardPane, revealPane: revealBoardPane });
}

/** Pan only enough to reveal the changed tile; preserve the reader's scale. */
export function revealBoardPane(paneId: string): void {
  if (!host.viewport || !host.stage) return;
  const tile = [...host.stage.querySelectorAll<HTMLElement>(".board-pane")].find(tile => tile.dataset.paneId === paneId);
  if (!tile) return;
  const view = host.viewport.getBoundingClientRect();
  const rect = tile.getBoundingClientRect();
  const delta = (start: number, end: number, min: number, max: number) =>
    end - start > max - min ? min - start : start < min ? min - start : end > max ? max - end : 0;
  const camera = readBoardCamera();
  settleCamera(host.stage, { ...camera, panX: camera.panX + delta(rect.left, rect.right, view.left + 8, view.right - 8),
    panY: camera.panY + delta(rect.top, rect.bottom, view.top + 8, view.bottom - 8) }, writeBoardCamera);
}

/** Placement picked a side; the split sheet asks what to start there. */
export function pickBoardSplit(paneId: string, direction: SplitDirection): void {
  openBoardSplitSheet(paneId, direction, revealBoardPane);
}

/**
 * Where the camera sits against the whole-tab fit, for the zoom control. The
 * stored `fitted` flag only says a fit happened once (pans keep it), so this
 * measures the mounted canvas instead.
 */
export function boardZoomState(): { atFit: boolean; percent: number } {
  const camera = readBoardCamera();
  const percent = Math.round(camera.scale * 100);
  if (!host.viewport || !host.layout || !host.viewport.clientWidth) return { atFit: true, percent };
  const fit = fitCameraToViewport(host.viewport, host.layout);
  const atFit = Math.abs(fit.scale - camera.scale) < 0.002 && Math.abs(fit.panX - camera.panX) < 1.5
    && Math.abs(fit.panY - camera.panY) < 1.5;
  return { atFit, percent };
}

export function createBoardCanvasController(): BoardCanvasController {
  return {
    commitResize: commitBoardResize,
    commitSwap: commitBoardSwap,
    pickSplit: pickBoardSplit,
    layoutReason: boardLayoutReason,
    openResizeSheet: openBoardResizeSheet,
    toggleZoom: toggleBoardZoom,
    paneAction: boardPaneAction,
    openMenu: showBoardPaneMenu,
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
  // Arriving on the board starts over: only the next tile it opens earns a way back.
  clearBoardReturn();
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
  leaveBoardForTab();
  goToScreen("home");
  commitView();
}

/**
 * Back from the board that had the row to itself (the desk's narrowest tier).
 * The list returns beside the session it stood beside before the board took
 * the row, opened as choosing its row would open it; without one, beside the
 * empty main column.
 */
export function leaveBoardForList(): void {
  // The pane it showed is still open and still reported; anything else is the plain list.
  const pane = selectedAgent();
  if (!pane) {
    closeBoard();
    return;
  }
  clearBoardReturn();
  void openPane(pane.paneId);
}

/**
 * Drop the board's scroll ownership and return flag before a sibling tab takes
 * the screen. The caller navigates; nothing here commits.
 */
export function leaveBoardForTab(): void {
  releaseBoardScroll();
  setBoardReturn(false);
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

/**
 * The board's "+ tab" opens the shared create sheet on the board's workspace.
 * A board with no workspace has nothing to add a tab to: its empty card's
 * action opens the sheet as the list's own create does, on a new workspace.
 */
export function newTabInBoard(): void {
  const catalog = liveCatalog();
  const agent =
    boardTabAnchor(liveAgents() as DashboardAgentCard[], catalog.workspaceId, catalog.tabId) || selectedAgent();
  void openCreateSheet({ workspaceId: agent?.workspaceId || catalog.workspaceId || undefined });
}

export function boardScreenActions(): BoardScreenActions {
  return {
    back: closeBoard,
    selectWorkspace,
    selectTab,
    createTab: newTabInBoard,
    quickCreate: () => openQuickCreate(),
    tabMenu: (tabId) => openBoardTabMenu(tabId, newTabInBoard),
    fit: fitCurrentBoard,
    zoom: nudgeBoardZoom,
  };
}

/** One instance each: the route and the compatibility canvas share them. */
export const boardActions = boardScreenActions();
/** The same intents for the board that took the list's column: back returns the list. */
export const boardAloneActions: BoardScreenActions = { ...boardActions, back: leaveBoardForList };
export const boardCanvasController = createBoardCanvasController();

export { releaseBoardScroll };
export { boardLayoutReason, boardPaneAction, commitBoardResize, commitBoardSwap, openBoardResizeSheet, toggleBoardZoom };
