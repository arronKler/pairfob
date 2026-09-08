import { visibleTabLabel } from "../lib/dashboard";
import { t } from "../lib/i18n";
import { tabsInWorkspace, workspaceChipLabel } from "../lib/layout";
import { wakeLiveReads } from "../live";
import { createSelectedTab } from "../live-operations";
import { render } from "../paint";
import { parkComposeView } from "../compose-drafts";
import { selectedAgent, state } from "../state";
import { refreshBoardPreviews } from "./board-preview";
import { leaveAgentChat } from "./agent-chat";
import { releaseBoardScroll } from "./board-canvas";
import { leaveFullTerminal } from "./full-terminal";
import { dropQueuedKeys } from "./session-view";
import { nextTransition, transitionFor } from "./transition";

export async function openBoard(from?: { workspaceId?: string; tabId?: string }): Promise<void> {
  parkComposeView();
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (state.agentChat) leaveAgentChat({ rememberGuided: false, paint: false });
  dropQueuedKeys();
  releaseBoardScroll();
  const selected = selectedAgent();
  state.boardWorkspaceId = from?.workspaceId || selected?.workspaceId || state.boardWorkspaceId;
  state.boardTabId = from?.tabId || (from?.workspaceId ? "" : selected?.tabId) || state.boardTabId;
  state.boardFitted = false;
  nextTransition(transitionFor(state.screen, "board"));
  state.screen = "board";
  render();
  void refreshBoardPreviews();
  wakeLiveReads();
}

export function closeBoard(): void {
  releaseBoardScroll();
  state.boardReturn = false;
  nextTransition(transitionFor(state.screen, "home"));
  state.screen = "home";
  render();
}

export function selectWorkspace(workspaceId: string): void {
  if (state.boardWorkspaceId === workspaceId) return;
  releaseBoardScroll();
  state.boardWorkspaceId = workspaceId;
  const tabs = tabsInWorkspace(state.tabList, workspaceId);
  state.boardTabId = tabs[0]?.id || "";
  state.boardFitted = false;
  render();
  void refreshBoardPreviews();
}

export function selectTab(tabId: string): void {
  if (state.boardTabId === tabId) return;
  releaseBoardScroll();
  state.boardTabId = tabId;
  state.boardFitted = false;
  render();
  void refreshBoardPreviews();
}

export function workspaceLabel(id: string, label: string): string {
  return workspaceChipLabel({ id, label }, state.workspaceList, state.agents, t("workspace.unnamed"));
}

export function tabLabel(tab: { id: string; label: string }, index: number): string {
  const named = visibleTabLabel(tab.label);
  if (named && !/^\d{1,3}$/.test(named)) return named;
  const count = state.agents.filter((agent) => agent.tabId === tab.id).length;
  if (count > 1) return t("detail.splitCount", { n: count });
  return t("board.tabIndex", { n: index + 1 });
}

export function markRailOverflow(rail: HTMLElement, scroller: HTMLElement): void {
  rail.classList.toggle("overflow", scroller.scrollWidth > scroller.clientWidth + 8);
}

export function revealSelection(root: HTMLElement): void {
  root.querySelector<HTMLElement>(".board-chip.on, .board-tab.on")?.scrollIntoView({
    inline: "nearest",
    block: "nearest",
  });
}

export function newTabInBoard(): void {
  const agent =
    state.agents.find((item) => item.workspaceId === state.boardWorkspaceId && item.tabId === state.boardTabId) ||
    state.agents.find((item) => item.workspaceId === state.boardWorkspaceId) ||
    selectedAgent();
  void createSelectedTab(agent);
}
