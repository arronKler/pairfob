import { visibleTabLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { tabsInWorkspace, workspaceChipLabel } from "../lib/layout";
import { wakeLiveReads } from "../live";
import { createSelectedTab } from "../live-operations";
import { render } from "../paint";
import { app, selectedAgent, state } from "../state";
import { refreshBoardPreviews } from "./board-preview";
import { leaveAgentChat } from "./agent-chat";
import { fillBoardCanvas, fitCurrentBoard, nudgeBoardZoom, releaseBoardScroll } from "./board-canvas";
import { appendNotice, backButton, herdBanners, herdStatus, statusLineNode } from "./chrome";
import { leaveFullTerminal } from "./full-terminal";
import { dropQueuedKeys } from "./session-view";

export async function openBoard(from?: { workspaceId?: string; tabId?: string }): Promise<void> {
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (state.agentChat) leaveAgentChat({ rememberGuided: false, paint: false });
  dropQueuedKeys();
  releaseBoardScroll();
  const selected = selectedAgent();
  state.boardWorkspaceId = from?.workspaceId || selected?.workspaceId || state.boardWorkspaceId;
  state.boardTabId = from?.tabId || (from?.workspaceId ? "" : selected?.tabId) || state.boardTabId;
  state.boardFitted = false;
  state.screen = "board";
  render();
  void refreshBoardPreviews();
  wakeLiveReads();
}

export function closeBoard(): void {
  releaseBoardScroll();
  state.boardReturn = false;
  state.screen = "home";
  render();
}

function selectWorkspace(workspaceId: string): void {
  if (state.boardWorkspaceId === workspaceId) return;
  releaseBoardScroll();
  state.boardWorkspaceId = workspaceId;
  const tabs = tabsInWorkspace(state.tabList, workspaceId);
  state.boardTabId = tabs[0]?.id || "";
  state.boardFitted = false;
  render();
  void refreshBoardPreviews();
}

function selectTab(tabId: string): void {
  if (state.boardTabId === tabId) return;
  releaseBoardScroll();
  state.boardTabId = tabId;
  state.boardFitted = false;
  render();
  void refreshBoardPreviews();
}

function workspaceLabel(id: string, label: string): string {
  return workspaceChipLabel({ id, label }, state.workspaceList, state.agents, t("workspace.unnamed"));
}

function tabLabel(tab: { id: string; label: string }, index: number): string {
  const named = visibleTabLabel(tab.label);
  if (named && !/^\d{1,3}$/.test(named)) return named;
  const count = state.agents.filter((agent) => agent.tabId === tab.id).length;
  if (count > 1) return t("detail.splitCount", { n: count });
  return t("board.tabIndex", { n: index + 1 });
}

function markRailOverflow(rail: HTMLElement, scroller: HTMLElement): void {
  rail.classList.toggle("overflow", scroller.scrollWidth > scroller.clientWidth + 8);
}

function revealSelection(root: HTMLElement): void {
  root.querySelector<HTMLElement>(".board-chip.on, .board-tab.on")?.scrollIntoView({
    inline: "nearest",
    block: "nearest",
  });
}

function newTabInBoard(): void {
  const agent =
    state.agents.find((item) => item.workspaceId === state.boardWorkspaceId && item.tabId === state.boardTabId) ||
    state.agents.find((item) => item.workspaceId === state.boardWorkspaceId) ||
    selectedAgent();
  void createSelectedTab(agent);
}

export function renderBoard(): void {
  const status = herdStatus();
  const root = node("div", "board-shell");
  const chrome = node("header", "board-chrome");
  chrome.append(backButton(closeBoard, t("board.back")));
  const title = node("div", "board-title");
  title.append(node("strong", "board-name", t("board.title")));
  const current = state.workspaceList.find((item) => item.id === state.boardWorkspaceId);
  if (current) title.append(node("span", "board-sub", workspaceLabel(current.id, current.label)));
  chrome.append(title);
  const zoom = node("div", "board-zoom");
  const out = button("−", "icon-btn", () => nudgeBoardZoom(-1));
  out.setAttribute("aria-label", t("board.zoomOut"));
  const fit = button(t("board.fit"), "text-link", fitCurrentBoard);
  fit.setAttribute("aria-label", t("board.fitAria"));
  const inn = button("+", "icon-btn", () => nudgeBoardZoom(1));
  inn.setAttribute("aria-label", t("board.zoomIn"));
  zoom.append(out, fit, inn);
  chrome.append(zoom);
  root.append(chrome, statusLineNode(status));
  herdBanners(root, status);
  appendNotice(root);

  const spaceRail = node("div", "board-rail");
  const spaces = node("div", "board-spaces");
  spaces.setAttribute("role", "tablist");
  spaces.setAttribute("aria-label", t("board.workspaceAria"));
  for (const space of state.workspaceList) {
    const on = space.id === state.boardWorkspaceId;
    const chip = button(workspaceLabel(space.id, space.label), `board-chip${on ? " on" : ""}`, () => selectWorkspace(space.id));
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", String(on));
    spaces.append(chip);
  }
  if (!state.workspaceList.length) spaces.append(node("p", "empty-sub", t("board.empty")));
  spaceRail.append(spaces);
  root.append(spaceRail);

  const tabRail = node("div", "board-rail");
  const tabs = node("div", "board-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("board.tabAria"));
  for (const [index, tab] of tabsInWorkspace(state.tabList, state.boardWorkspaceId).entries()) {
    const on = tab.id === state.boardTabId;
    const item = button(tabLabel(tab, index), `board-tab${on ? " on" : ""}`, () => selectTab(tab.id));
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(on));
    tabs.append(item);
  }
  if (state.operationCapabilities.create_tab) {
    const create = button(state.operationBusy ? t("home.creating") : t("board.newTab"), "board-tab-new", newTabInBoard);
    create.disabled = state.operationBusy || !state.live?.isConnected() || !state.boardWorkspaceId;
    tabs.append(create);
  }
  tabRail.append(tabs);
  root.append(tabRail);
  fillBoardCanvas(root);
  app.replaceChildren(root);
  requestAnimationFrame(() => {
    markRailOverflow(spaceRail, spaces);
    markRailOverflow(tabRail, tabs);
    revealSelection(root);
  });
}
