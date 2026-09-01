import { agentMeta, agentTitle, statusLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import {
  groupAgents,
  paneIsPinned,
  PINNED_GROUP_ID,
  syncGroupCollapsed,
  toggleGroupCollapsed,
  type AgentCard,
  type AgentGroup,
} from "../lib/ranking";
import { emptySessionCopy } from "../lib/ui-model";
import { openComputers } from "../computers";
import { openPane } from "../live";
import { startNewConversation } from "../live-operations";
import { openSettings } from "../live-settings";
import { render } from "../paint";
import { app, state } from "../state";
import {
  brandNode,
  chevron,
  emptyNode,
  groupToggle,
  herdBanners,
  herdStatus,
  listGroupControl,
  noteNode,
  sectionTitle,
  statusLineNode,
} from "./chrome";
import { openListPaneMenu, openListWorkspaceMenu } from "./list-menu";
import { bindObjectPress } from "./press-menu";

export function agentCard(agent: AgentCard): HTMLElement {
  const selected = agent.paneId === state.paneId;
  const pinned = paneIsPinned(state.panePinned, agent.paneId);
  const title = agentTitle(agent, state.listGroup);
  const card = node("article", `card status-${agent.status}${selected ? " sel" : ""}${pinned ? " pinned" : ""}`);
  const main = button("", "card-main", () => void openPane(agent.paneId));
  main.setAttribute("aria-pressed", selected ? "true" : "false");
  main.setAttribute("aria-haspopup", "menu");
  const copy = node("div", "card-copy");
  const titleRow = node("div", "card-title");
  if (pinned) {
    const mark = node("span", "pin-mark");
    mark.setAttribute("aria-hidden", "true");
    titleRow.append(mark, node("span", "sr-only", t("home.pinned")));
  }
  titleRow.append(node("span", "card-name", title));
  const pill = statusLabel(agent.status);
  if (pill) titleRow.append(node("span", `pill pill-${agent.status}`, pill));
  copy.append(titleRow);
  const meta = agentMeta(agent, state.listGroup);
  if (meta) copy.append(node("p", "card-meta", meta));
  main.append(copy, chevron());
  bindObjectPress(main, () => {
    if (state.operationBusy || !state.live?.isConnected()) return;
    openListPaneMenu(agent);
  });
  card.append(main);
  return card;
}

export function fillHerdList(root: HTMLElement): void {
  root.append(listGroupControl());
  if (!state.agents.length) {
    const copy = emptySessionCopy(
      state.runtimeKind,
      state.live?.isConnected() === true,
      state.operationCapabilities.create_conversation,
    );
    root.append(emptyNode(copy.title, copy.detail));
    return;
  }
  const groups = groupAgents(state.agents, state.listGroup, state.paneTouched, state.panePinned);
  const list = node("div", "herd-list");
  if (state.listGroup === "flat") {
    for (const group of groups) {
      list.append(sectionTitle(group.title, group.items.length));
      group.items.forEach((agent) => list.append(agentCard(agent)));
    }
  } else {
    state.listGroupCollapsed = syncGroupCollapsed(groups, state.listGroupCollapsed);
    for (const group of groups) list.append(herdGroup(group, groups));
  }
  root.append(list);
}

function herdGroup(group: AgentGroup, groups: AgentGroup[]): HTMLElement {
  const collapsed = state.listGroupCollapsed[group.id] === true;
  const section = node("section", "herd-group");
  const heading = groupToggle(group.title, group.items.length, !collapsed, () => {
    state.listGroupCollapsed = toggleGroupCollapsed(groups, state.listGroupCollapsed, group.id);
    render();
  });
  if (state.listGroup === "space" && group.id !== PINNED_GROUP_ID) {
    const agent = group.items.find((item) => item.workspaceId) ?? group.items[0];
    if (agent?.workspaceId) {
      heading.setAttribute("aria-haspopup", "menu");
      bindObjectPress(heading, () => {
        if (state.operationBusy || !state.live?.isConnected()) return;
        openListWorkspaceMenu(agent);
      });
    }
  }
  section.append(heading);
  const body = node("div", "herd-group-body");
  body.hidden = collapsed;
  group.items.forEach((item) => body.append(agentCard(item)));
  section.append(body);
  return section;
}

function liveActions(): HTMLElement {
  const actions = node("div", "topbar-actions");
  if (state.operationCapabilities.create_conversation) {
    const create = button(state.operationBusy ? t("home.creating") : t("home.new"), "topbar-create", startNewConversation);
    create.disabled = state.operationBusy || !state.live?.isConnected();
    create.setAttribute("aria-label", t("home.newAria"));
    actions.append(create);
  }
  if (state.computers.length > 1) actions.append(button(t("home.computers"), "text-link", openComputers));
  actions.append(button(t("home.settings"), "text-link", openSettings));
  return actions;
}

export function renderHome(): void {
  const status = herdStatus();
  const root = node("div", "page");
  const top = node("div", "topbar");
  top.append(brandNode(status.tone, true), liveActions());
  root.append(top, statusLineNode(status));
  herdBanners(root, status);
  fillHerdList(root);
  const error = noteNode();
  if (error) root.append(error);
  app.replaceChildren(root);
}

export function renderRail(): HTMLElement {
  const status = herdStatus();
  const rail = node("aside", "rail");
  const top = node("div", "topbar");
  top.append(brandNode(status.tone, true), liveActions());
  rail.append(top, statusLineNode(status));
  herdBanners(rail, status);
  fillHerdList(rail);
  return rail;
}
