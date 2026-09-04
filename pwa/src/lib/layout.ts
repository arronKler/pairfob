import type { SnapshotWire } from "./dashboard.ts";
import type { AgentCard } from "./ranking.ts";

export type LayoutRect = { x: number; y: number; width: number; height: number };

export type TabLayout = {
  workspaceId: string;
  tabId: string;
  zoomed: boolean;
  area: LayoutRect;
  focusedPaneId: string;
  panes: Array<{ paneId: string; focused: boolean; rect: LayoutRect }>;
};

export type PaneBox = {
  paneId: string;
  focused: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BoardSpace = { id: string; label: string };
export type BoardTab = { id: string; workspaceId: string; label: string };

export type BoardCatalog = {
  workspaces: BoardSpace[];
  tabs: BoardTab[];
};

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourceId(value: unknown): string {
  return typeof value === "string" && RESOURCE_ID.test(value) ? value : "";
}

function rect(value: unknown): LayoutRect | null {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n) && n >= 0)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function parseSnapshotLayouts(snapshot: SnapshotWire | { layouts?: unknown }): TabLayout[] {
  const raw = (snapshot as { layouts?: unknown }).layouts;
  if (!Array.isArray(raw)) return [];
  const out: TabLayout[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const workspaceId = resourceId(item.workspace_id);
    const tabId = resourceId(item.tab_id);
    const area = rect(item.area);
    if (!workspaceId || !tabId || !area) continue;
    const panes: TabLayout["panes"] = [];
    if (Array.isArray(item.panes)) {
      for (const pane of item.panes) {
        if (!isRecord(pane)) continue;
        const paneId = resourceId(pane.pane_id);
        const paneRect = rect(pane.rect);
        if (!paneId || !paneRect) continue;
        panes.push({ paneId, focused: pane.focused === true, rect: paneRect });
      }
    }
    if (!panes.length) continue;
    out.push({
      workspaceId,
      tabId,
      zoomed: item.zoomed === true,
      area,
      focusedPaneId: resourceId(item.focused_pane_id),
      panes,
    });
  }
  return out;
}

export function layoutSignature(layouts: TabLayout[]): string {
  return JSON.stringify(
    layouts.map((layout) => [
      layout.workspaceId,
      layout.tabId,
      layout.zoomed,
      layout.focusedPaneId,
      layout.area,
      layout.panes.map((pane) => [pane.paneId, pane.focused, pane.rect]),
    ]),
  );
}

export function catalogFromSnapshot(snapshot: SnapshotWire, agents: AgentCard[]): BoardCatalog {
  const workspaces: BoardSpace[] = [];
  const seenWorkspace = new Set<string>();
  for (const item of snapshot.workspaces || []) {
    if (!item.workspace_id || seenWorkspace.has(item.workspace_id)) continue;
    seenWorkspace.add(item.workspace_id);
    workspaces.push({ id: item.workspace_id, label: item.label?.trim() || "" });
  }
  const tabs: BoardTab[] = [];
  const seenTab = new Set<string>();
  for (const item of snapshot.tabs || []) {
    if (!item.tab_id || seenTab.has(item.tab_id)) continue;
    seenTab.add(item.tab_id);
    tabs.push({ id: item.tab_id, workspaceId: item.workspace_id, label: item.label?.trim() || "" });
  }
  for (const agent of agents) {
    if (agent.workspaceId && !seenWorkspace.has(agent.workspaceId)) {
      seenWorkspace.add(agent.workspaceId);
      workspaces.push({ id: agent.workspaceId, label: agent.workspaceLabel });
    }
    if (agent.tabId && !seenTab.has(agent.tabId)) {
      seenTab.add(agent.tabId);
      tabs.push({ id: agent.tabId, workspaceId: agent.workspaceId || "", label: agent.tabLabel || "" });
    }
  }
  return { workspaces, tabs };
}

export function fallbackTabLayout(workspaceId: string, tabId: string, paneIds: string[]): TabLayout | null {
  if (!workspaceId || !tabId || !paneIds.length) return null;
  const area: LayoutRect = { x: 0, y: 0, width: 120, height: 40 };
  const width = Math.max(1, Math.floor(area.width / paneIds.length));
  const panes = paneIds.map((paneId, index) => {
    const x = index * width;
    const last = index === paneIds.length - 1;
    return {
      paneId,
      focused: index === 0,
      rect: { x, y: 0, width: last ? area.width - x : width, height: area.height },
    };
  });
  return { workspaceId, tabId, zoomed: false, area, focusedPaneId: paneIds[0] ?? "", panes };
}

export function layoutForTab(tabId: string, layouts: TabLayout[], agents: AgentCard[]): TabLayout | null {
  if (!tabId) return null;
  const found = layouts.find((item) => item.tabId === tabId);
  if (found) return found;
  const siblings = agents.filter((agent) => agent.tabId === tabId);
  if (!siblings.length) return null;
  return fallbackTabLayout(siblings[0].workspaceId || "", tabId, siblings.map((agent) => agent.paneId));
}

export function layoutForPane(paneId: string, layouts: TabLayout[], agents: AgentCard[]): TabLayout | null {
  if (!paneId) return null;
  const found = layouts.find((item) => item.panes.some((pane) => pane.paneId === paneId));
  if (found) return found;
  const agent = agents.find((item) => item.paneId === paneId);
  return agent?.tabId ? layoutForTab(agent.tabId, layouts, agents) : null;
}

/** Cell grid of one pane on the computer. Used so a phone open does not resize that split. */
export function paneCellGrid(
  paneId: string,
  layout: TabLayout | null,
  viewportRows?: number,
): { cols: number; rows: number } | null {
  if (!paneId || !layout) return null;
  const pane = layout.panes.find((item) => item.paneId === paneId);
  if (!pane) return null;
  const cols = Math.round(pane.rect.width);
  const rows = viewportRows && viewportRows >= 8 ? Math.round(viewportRows) : Math.round(pane.rect.height);
  if (!(cols > 0) || !(rows > 0)) return null;
  return { cols, rows };
}

export function panePtySize(
  paneId: string,
  layouts: TabLayout[],
  agents: AgentCard[],
): { cols: number; rows: number } | null {
  return paneCellGrid(
    paneId,
    layoutForPane(paneId, layouts, agents),
    agents.find((item) => item.paneId === paneId)?.viewportRows,
  );
}

/** One terminal cell on the board. Height is 2× width, like a typical mono glyph. */
export const BOARD_CELL_W = 8;
export const BOARD_CELL_H = 16;
export const BOARD_CELL_PX = BOARD_CELL_W;

/** Stage-pixel boxes. Percentages on `<button>` tiles collapse toward min-content and paint 1:1:2 as 1:1:1. */
export function paneBoxes(layout: TabLayout): PaneBox[] {
  const { area } = layout;
  if (area.width <= 0 || area.height <= 0) return [];
  return layout.panes
    .map((pane) => ({
      paneId: pane.paneId,
      focused: pane.focused || pane.paneId === layout.focusedPaneId,
      left: (pane.rect.x - area.x) * BOARD_CELL_W,
      top: (pane.rect.y - area.y) * BOARD_CELL_H,
      width: pane.rect.width * BOARD_CELL_W,
      height: pane.rect.height * BOARD_CELL_H,
    }))
    .filter((box) => box.width > 0 && box.height > 0);
}

export function tabsInWorkspace(tabs: BoardTab[], workspaceId: string): BoardTab[] {
  return tabs.filter((tab) => tab.workspaceId === workspaceId);
}

export function resolveBoardFocus(
  workspaceId: string,
  tabId: string,
  catalog: BoardCatalog,
  snapshot: SnapshotWire,
): { workspaceId: string; tabId: string } {
  const spaces = catalog.workspaces;
  if (!spaces.length) return { workspaceId: "", tabId: "" };
  const currentSpace = spaces.some((item) => item.id === workspaceId) ? workspaceId : "";
  const focusedSpace = resourceId(snapshot.focused?.workspace_id);
  const nextSpace =
    currentSpace ||
    (spaces.some((item) => item.id === focusedSpace) ? focusedSpace : "") ||
    spaces[0].id;
  const tabs = tabsInWorkspace(catalog.tabs, nextSpace);
  if (!tabs.length) return { workspaceId: nextSpace, tabId: "" };
  const currentTab = tabs.some((item) => item.id === tabId) ? tabId : "";
  const focusedTab = resourceId(snapshot.focused?.tab_id);
  const nextTab =
    currentTab ||
    (tabs.some((item) => item.id === focusedTab) ? focusedTab : "") ||
    tabs[0].id;
  return { workspaceId: nextSpace, tabId: nextTab };
}

export const BOARD_SCALE_MIN = 0.12;
export const BOARD_SCALE_MAX = 4;

export function cwdTail(cwd: string, parts = 2): string {
  const bits = cwd.split("/").filter(Boolean);
  if (!bits.length) return "";
  return bits.slice(-Math.max(1, parts)).join("/");
}

export function workspaceChipLabel(
  space: BoardSpace,
  spaces: BoardSpace[],
  agents: AgentCard[],
  unnamed: string,
): string {
  const agent = agents.find((item) => item.workspaceId === space.id);
  const base = space.label.trim() || agent?.workspaceLabel?.trim() || cwdTail(agent?.cwd || "", 1) || unnamed;
  const dupes = spaces.filter((item) => {
    const other = agents.find((entry) => entry.workspaceId === item.id);
    const name = item.label.trim() || other?.workspaceLabel?.trim() || cwdTail(other?.cwd || "", 1) || unnamed;
    return name.toLowerCase() === base.toLowerCase();
  });
  if (dupes.length < 2) return base;
  const tail = cwdTail(agent?.cwd || "");
  if (tail && tail.toLowerCase() !== base.toLowerCase()) return `${base} · ${tail}`;
  return base;
}

export function numberDuplicateTitles(
  items: Array<{ id: string; title: string; cwd: string }>,
): Record<string, string> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = `${item.title}\0${item.cwd}`;
    const list = groups.get(key) ?? [];
    list.push(item.id);
    groups.set(key, list);
  }
  const out: Record<string, string> = {};
  for (const item of items) {
    const ids = groups.get(`${item.title}\0${item.cwd}`) ?? [];
    const index = ids.indexOf(item.id);
    out[item.id] = ids.length > 1 && index > 0 ? `${item.title} · ${index + 1}` : item.title;
  }
  return out;
}

export function boardStateFromSnapshot(
  snapshot: SnapshotWire,
  agents: AgentCard[],
  workspaceId: string,
  tabId: string,
): {
  layouts: TabLayout[];
  workspaceList: BoardSpace[];
  tabList: BoardTab[];
  lastLayoutSig: string;
  boardWorkspaceId: string;
  boardTabId: string;
  refit: boolean;
} {
  const layouts = parseSnapshotLayouts(snapshot);
  const catalog = catalogFromSnapshot(snapshot, agents);
  const focus = resolveBoardFocus(workspaceId, tabId, catalog, snapshot);
  return {
    layouts,
    workspaceList: catalog.workspaces,
    tabList: catalog.tabs,
    lastLayoutSig: layoutSignature(layouts),
    boardWorkspaceId: focus.workspaceId,
    boardTabId: focus.tabId,
    refit: focus.workspaceId !== workspaceId || focus.tabId !== tabId,
  };
}

export function clampBoardScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(BOARD_SCALE_MAX, Math.max(BOARD_SCALE_MIN, value));
}

export function fitBoardCamera(
  viewWidth: number,
  viewHeight: number,
  stageWidth: number,
  stageHeight: number,
  padding = 20,
): { scale: number; panX: number; panY: number } {
  if (viewWidth <= 0 || viewHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) {
    return { scale: 1, panX: 0, panY: 0 };
  }
  const availableW = Math.max(1, viewWidth - padding * 2);
  const availableH = Math.max(1, viewHeight - padding * 2);
  const scale = clampBoardScale(Math.min(availableW / stageWidth, availableH / stageHeight, 1.6));
  return {
    scale,
    panX: (viewWidth - stageWidth * scale) / 2,
    panY: (viewHeight - stageHeight * scale) / 2,
  };
}

/** First open fits the whole tab so every pane cell is on screen. */
export function initialBoardCamera(
  viewWidth: number,
  viewHeight: number,
  stageWidth: number,
  stageHeight: number,
  padding = 20,
): { scale: number; panX: number; panY: number } {
  return fitBoardCamera(viewWidth, viewHeight, stageWidth, stageHeight, padding);
}
