import { agentMeta, agentTitle, statusLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { groupAgents, syncGroupCollapsed, toggleGroupCollapsed, type AgentCard, type AgentGroup } from "../lib/ranking";
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
import { openListPaneMenu } from "./list-menu";

export function agentCard(agent: AgentCard): HTMLElement {
  const selected = agent.paneId === state.paneId;
  const title = agentTitle(agent, state.listGroup);
  const card = node("article", `card status-${agent.status}${selected ? " sel" : ""}`);
  const main = button("", "card-main", () => void openPane(agent.paneId));
  main.setAttribute("aria-pressed", selected ? "true" : "false");
  const copy = node("div", "card-copy");
  const titleRow = node("div", "card-title");
  titleRow.append(node("span", "card-name", title));
  const pill = statusLabel(agent.status);
  if (pill) titleRow.append(node("span", `pill pill-${agent.status}`, pill));
  copy.append(titleRow);
  const meta = agentMeta(agent, state.listGroup);
  if (meta) copy.append(node("p", "card-meta", meta));
  main.append(copy, chevron());
  const split = node("span", "card-split");
  split.setAttribute("aria-hidden", "true");
  const more = button("", "icon-btn icon-more card-more", () => openListPaneMenu(agent));
  more.setAttribute("aria-label", t("home.cardMenu", { title }));
  more.disabled = state.operationBusy || !state.live?.isConnected();
  more.addEventListener("click", (event) => event.stopPropagation());
  card.append(main, split, more);
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
  const groups = groupAgents(state.agents, state.listGroup, state.paneTouched);
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
  section.append(groupToggle(group.title, group.items.length, !collapsed, () => {
    state.listGroupCollapsed = toggleGroupCollapsed(groups, state.listGroupCollapsed, group.id);
    render();
  }));
  const body = node("div", "herd-group-body");
  body.hidden = collapsed;
  group.items.forEach((agent) => body.append(agentCard(agent)));
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
