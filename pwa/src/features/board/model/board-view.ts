/**
 * Board screen view model.
 *
 * Pure projection of the workspace/tab catalog and the current tab layout into
 * everything the board screen renders: rail chips, chrome copy, capability
 * gates and the canvas tiles. No application record, no DOM, no session.
 */
import { agentTitle, agentStatusLabel, visibleTabLabel, type DashboardAgentCard } from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import {
  layoutForTab,
  numberDuplicateTitles,
  paneBoxes,
  tabsInWorkspace,
  workspaceChipLabel,
  type BoardSpace,
  type BoardTab,
  type PaneBox,
  type TabLayout,
} from "../../../lib/layout";
import { herdNeedsReader, type HerdStatus } from "../../dashboard/model/herd-view";
import { boardStageSize } from "./camera";

export type BoardModelInput = {
  /** Published domain data is read-only by contract; the projection copies once. */
  workspaceList: readonly BoardSpace[];
  tabList: readonly BoardTab[];
  agents: readonly DashboardAgentCard[];
  layouts: readonly TabLayout[];
  workspaceId: string;
  tabId: string;
  selectedPaneId: string;
  status: HerdStatus;
  canCreateTab: boolean;
  /**
   * A session can be started in a workspace of its own (`create_conversation`),
   * which is what the list's create offers. Absent means it cannot.
   */
  canCreateWorkspace?: boolean;
  /** The advertised layout capabilities; absent keys mean the daemon cannot. */
  layoutCaps: { resize: boolean; swap: boolean; split: boolean; zoom: boolean };
  operationBusy: boolean;
  connected: boolean;
  /**
   * Whether a session can be created right now, as the list decides it
   * (`canCreateSession`): false while the computer is still being read, or its
   * Herdr is gone or silent. Absent means the caller did not ask.
   */
  creatable?: boolean;
};

export type BoardRailChip = { id: string; label: string; selected: boolean };

/** A tab chip also says whether a pane inside waits on the reader. */
export type BoardTabChip = BoardRailChip & { attention: "blocked" | "done" | "" };

/** One workspace as the title and the switcher sheet show it. */
export type BoardSpaceView = {
  id: string;
  label: string;
  path: string;
  selected: boolean;
  blockedCount: number;
  doneCount: number;
};

export type BoardTileView = {
  paneId: string;
  box: PaneBox;
  className: string;
  title: string;
  aria: string;
  status: string;
  /** The advertised agent kind; empty for a plain terminal, which carries no status word. */
  agentKind: string;
  /** The status word the title bar shows, colored like the session rows; "" for a plain terminal. */
  pill: string;
  selected: boolean;
  zoomed: boolean;
  cols: number;
  rows: number;
};

export type BoardCanvasModel = {
  highlightedPaneId?: string;
  /** Identity of the bound layout; the canvas rebinds gestures when it changes. */
  signature: string;
  tabId: string;
  layout: TabLayout | null;
  size: { width: number; height: number } | null;
  tiles: BoardTileView[];
  emptyTitle: string;
  emptySub: string;
  canvasAria: string;
  /** The pane herdr is showing alone ("在电脑上铺满"); "" when the tab is split. */
  zoomedPaneId: string;
  /** The tab row's bar while zoomed: what the computer shows and how to restore the split. */
  zoomBanner: { text: string; restore: string };
  /**
   * Divider handles show only when the computer advertises resize_pane and the
   * layout is herdr's own, never for a stand-in built from the pane list.
   */
  canResize: boolean;
};

export type BoardViewModel = {
  back: string;
  title: string;
  sub: string | null;
  zoom: { out: string; fit: string; fitLabel: string; in: string };
  spaces: BoardSpaceView[];
  /** The selected workspace; null when the board has none. */
  workspace: BoardSpaceView | null;
  spacesEmpty: string;
  spaceAria: string;
  tabs: BoardTabChip[];
  tabAria: string;
  create: { label: string; disabled: boolean } | null;
  status: HerdStatus;
  canvas: BoardCanvasModel;
};

/** A chip says the workspace name; duplicates keep a folder tail. */
export function boardWorkspaceLabel(
  space: BoardSpace,
  spaces: BoardSpace[],
  agents: DashboardAgentCard[],
): string {
  return workspaceChipLabel(space, spaces, agents, t("workspace.unnamed"));
}

/** A named tab keeps its name; a numbered or unnamed one falls back to size. */
export function boardTabLabel(
  tab: { id: string; label: string },
  index: number,
  agents: DashboardAgentCard[],
): string {
  const named = visibleTabLabel(tab.label);
  if (named && !/^\d{1,3}$/.test(named)) return named;
  const count = agents.filter((agent) => agent.tabId === tab.id).length;
  if (count > 1) return t("detail.splitCount", { n: count });
  return t("board.tabIndex", { n: index + 1 });
}

export function boardTileClassName(box: PaneBox, selected: boolean, status: string): string {
  return `board-pane status-${status}${selected ? " sel" : ""}${box.focused ? " focused" : ""}`;
}

/** Tile geometry, titles and status pills for one resolved tab layout. */
export function boardTiles(
  layout: TabLayout,
  agents: DashboardAgentCard[],
  selectedPaneId: string,
): BoardTileView[] {
  const boxes = paneBoxes(layout);
  const titles = numberDuplicateTitles(
    boxes.map((box) => {
      const agent = agents.find((item) => item.paneId === box.paneId);
      return { id: box.paneId, title: agent ? agentTitle(agent, "flat") : box.paneId, cwd: agent?.cwd || "" };
    }),
  );
  return boxes.map((box) => {
    const agent = agents.find((item) => item.paneId === box.paneId);
    const pane = layout.panes.find((item) => item.paneId === box.paneId);
    const status = agent?.status || "idle";
    const title = titles[box.paneId] || box.paneId;
    return {
      paneId: box.paneId,
      box,
      className: boardTileClassName(box, box.paneId === selectedPaneId, status),
      title,
      aria: t("board.paneAria", { title }),
      status,
      agentKind: agent?.hasAgent ? agent.agent : "",
      pill: agent?.hasAgent ? agentStatusLabel(agent) : "",
      selected: box.paneId === selectedPaneId,
      zoomed: layout.zoomed && (box.focused || box.paneId === layout.focusedPaneId),
      cols: Math.round(pane?.rect.width || 0),
      rows: Math.round(pane?.rect.height || 0),
    };
  });
}

/**
 * What herdr draws: a zoomed tab shows its zoomed pane alone, filling the area.
 * The zoomed pane is the focused one (herdr zooms the focused pane); a snapshot
 * that reports only the visible pane resolves to that pane as well.
 */
export function visibleTabLayout(layout: TabLayout): { layout: TabLayout; zoomedPaneId: string } {
  if (!layout.zoomed) return { layout, zoomedPaneId: "" };
  const pane = layout.panes.find((item) => item.paneId === layout.focusedPaneId)
    ?? layout.panes.find((item) => item.focused) ?? layout.panes[0];
  if (!pane) return { layout, zoomedPaneId: "" };
  return {
    layout: { ...layout, panes: [{ ...pane, focused: true, rect: { ...layout.area } }] },
    zoomedPaneId: pane.paneId,
  };
}

export function boardCanvasModel(input: BoardModelInput): BoardCanvasModel {
  const agents = [...input.agents] as DashboardAgentCard[];
  const resolved = layoutForTab(input.tabId, [...input.layouts] as TabLayout[], agents);
  const visible = resolved ? visibleTabLayout(resolved) : null;
  const layout = visible?.layout ?? null;
  return {
    signature: JSON.stringify(layout),
    tabId: input.tabId,
    layout,
    size: layout ? boardStageSize(layout) : null,
    tiles: layout ? boardTiles(layout, agents, input.selectedPaneId) : [],
    emptyTitle: t("board.emptyTitle"),
    emptySub: t("board.empty"),
    canvasAria: t("board.canvasAria"),
    zoomedPaneId: visible?.zoomedPaneId ?? "",
    canResize: input.layoutCaps.resize && input.layouts.some((item) => item.tabId === input.tabId),
    zoomBanner: { text: t("boardCanvas.zoomedBanner"), restore: t("boardMenu.restore") },
  };
}

/**
 * The board's create entry. Beside its tabs it is "+ tab", which needs the
 * board's workspace. A board with no tab draws it as the empty card's action,
 * and there it is the list's own create: the first session goes in a workspace
 * of its own, so it answers whenever the list's does (`creatable`) and is held
 * exactly when that one is. A computer that only takes tabs still needs a
 * workspace to add one to.
 */
function boardCreate(input: BoardModelInput, hasTabs: boolean): BoardViewModel["create"] {
  const label = input.operationBusy ? t("home.creating") : t("board.newTab");
  const held = input.operationBusy || !input.connected || input.creatable === false;
  if (!hasTabs && input.canCreateWorkspace) return { label, disabled: held };
  return input.canCreateTab ? { label, disabled: held || !input.workspaceId } : null;
}

export function buildBoardViewModel(input: BoardModelInput): BoardViewModel {
  const spaces = [...input.workspaceList];
  const agents = [...input.agents];
  const current = spaces.find((space) => space.id === input.workspaceId);
  const tabs = tabsInWorkspace([...input.tabList], input.workspaceId);
  // Loss of contact never claims a status, so nothing is marked while stale.
  const known = input.status.tone === "live" || input.status.tone === "demo";
  const needs = (agent: DashboardAgentCard) => known ? herdNeedsReader(agent) : "";
  const spaceViews: BoardSpaceView[] = spaces.map((space) => {
    const inside = agents.filter((agent) => agent.workspaceId === space.id);
    return {
      id: space.id,
      label: boardWorkspaceLabel(space, spaces, agents),
      path: inside.find((agent) => agent.workspaceCwd)?.workspaceCwd || "",
      selected: space.id === input.workspaceId,
      blockedCount: inside.filter((agent) => needs(agent) === "blocked").length,
      doneCount: inside.filter((agent) => needs(agent) === "done").length,
    };
  });
  return {
    back: t("board.back"),
    title: t("board.title"),
    sub: current ? boardWorkspaceLabel(current, spaces, agents) : null,
    zoom: { out: t("board.zoomOut"), fit: t("board.fitAria"), fitLabel: t("board.fit"), in: t("board.zoomIn") },
    spaces: spaceViews,
    workspace: spaceViews.find((space) => space.selected) ?? null,
    spacesEmpty: t("board.empty"),
    spaceAria: t("board.workspaceAria"),
    tabs: tabs.map((tab, index) => {
      const marks = agents.filter((agent) => agent.tabId === tab.id).map(needs);
      return {
        id: tab.id,
        label: boardTabLabel(tab, index, agents),
        selected: tab.id === input.tabId,
        attention: marks.includes("blocked") ? "blocked" : marks.includes("done") ? "done" : "",
      };
    }),
    tabAria: t("board.tabAria"),
    create: boardCreate(input, tabs.length > 0),
    status: input.status,
    canvas: boardCanvasModel(input),
  };
}

/** The agent a "new tab beside" action should scope to, if any. */
export function boardTabAnchor(
  agents: DashboardAgentCard[],
  workspaceId: string,
  tabId: string,
): DashboardAgentCard | undefined {
  return (
    agents.find((item) => item.workspaceId === workspaceId && item.tabId === tabId) ||
    agents.find((item) => item.workspaceId === workspaceId)
  );
}

/** First tab of a workspace, which is what selecting a chip focuses. */
export function firstTabInWorkspace(tabList: BoardTab[], workspaceId: string): string {
  return tabsInWorkspace(tabList, workspaceId)[0]?.id || "";
}
