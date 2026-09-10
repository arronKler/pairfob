/**
 * Board screen view model.
 *
 * Pure projection of the workspace/tab catalog and the current tab layout into
 * everything the board screen renders: rail chips, chrome copy, capability
 * gates and the canvas tiles. No application record, no DOM, no session.
 */
import { agentTitle, statusLabel, visibleTabLabel, type DashboardAgentCard } from "../../../lib/dashboard";
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
import type { HerdStatus } from "../../dashboard/model/herd-view";
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
  operationBusy: boolean;
  connected: boolean;
};

export type BoardRailChip = { id: string; label: string; selected: boolean };

export type BoardTileView = {
  paneId: string;
  box: PaneBox;
  className: string;
  title: string;
  aria: string;
  status: string;
  pill: string;
  selected: boolean;
  zoomed: boolean;
  cols: number;
  rows: number;
};

export type BoardCanvasModel = {
  /** Identity of the bound layout; the canvas rebinds gestures when it changes. */
  signature: string;
  tabId: string;
  layout: TabLayout | null;
  size: { width: number; height: number } | null;
  tiles: BoardTileView[];
  emptyTitle: string;
  emptySub: string;
  zoomedLabel: string;
  canvasAria: string;
};

export type BoardViewModel = {
  back: string;
  title: string;
  sub: string | null;
  zoom: { out: string; fit: string; fitLabel: string; in: string };
  spaces: BoardRailChip[];
  spacesEmpty: string;
  spaceAria: string;
  tabs: BoardRailChip[];
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
      pill: agent ? statusLabel(agent.status) : "",
      selected: box.paneId === selectedPaneId,
      zoomed: layout.zoomed && (box.focused || box.paneId === layout.focusedPaneId),
      cols: Math.round(pane?.rect.width || 0),
      rows: Math.round(pane?.rect.height || 0),
    };
  });
}

export function boardCanvasModel(input: BoardModelInput): BoardCanvasModel {
  const agents = [...input.agents] as DashboardAgentCard[];
  const layout = layoutForTab(input.tabId, [...input.layouts] as TabLayout[], agents);
  return {
    signature: JSON.stringify(layout),
    tabId: input.tabId,
    layout,
    size: layout ? boardStageSize(layout) : null,
    tiles: layout ? boardTiles(layout, agents, input.selectedPaneId) : [],
    emptyTitle: t("board.emptyTitle"),
    emptySub: t("board.empty"),
    zoomedLabel: t("board.zoomed"),
    canvasAria: t("board.canvasAria"),
  };
}

export function buildBoardViewModel(input: BoardModelInput): BoardViewModel {
  const spaces = [...input.workspaceList];
  const agents = [...input.agents];
  const current = spaces.find((space) => space.id === input.workspaceId);
  const tabs = tabsInWorkspace([...input.tabList], input.workspaceId);
  return {
    back: t("board.back"),
    title: t("board.title"),
    sub: current ? boardWorkspaceLabel(current, spaces, agents) : null,
    zoom: { out: t("board.zoomOut"), fit: t("board.fitAria"), fitLabel: t("board.fit"), in: t("board.zoomIn") },
    spaces: spaces.map((space) => ({
      id: space.id,
      label: boardWorkspaceLabel(space, spaces, agents),
      selected: space.id === input.workspaceId,
    })),
    spacesEmpty: t("board.empty"),
    spaceAria: t("board.workspaceAria"),
    tabs: tabs.map((tab, index) => ({
      id: tab.id,
      label: boardTabLabel(tab, index, agents),
      selected: tab.id === input.tabId,
    })),
    tabAria: t("board.tabAria"),
    create: input.canCreateTab
      ? {
          label: input.operationBusy ? t("home.creating") : t("board.newTab"),
          disabled: input.operationBusy || !input.connected || !input.workspaceId,
        }
      : null,
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
