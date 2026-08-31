import { agentMeta, agentTitle, statusLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { groupAgents, syncGroupCollapsed, toggleGroupCollapsed, type AgentCard, type AgentGroup } from "../lib/ranking";
import { emptySessionCopy } from "../lib/ui-model";
import { openComputers } from "../computers";
import { openPane, openSettings, startNewConversation } from "../live";
import { render } from "../paint";
import { app, state } from "../state";
import {
  brandNode,
  chevron,
  emptyNode,
  groupToggle,
  herdBanners,
  herdStatus,
  issueLink,
  listGroupControl,
  noteNode,
  sectionTitle,
  statusLineNode,
} from "./chrome";

export function agentCard(agent: AgentCard): HTMLElement {
  const selected = agent.paneId === state.paneId;
  const card = node("article", `card status-${agent.status}${selected ? " sel" : ""}`);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-pressed", selected ? "true" : "false");
  const main = node("div", "card-main");
  const titleRow = node("div", "card-title");
  titleRow.append(node("span", "card-name", agentTitle(agent, state.listGroup)));
  const pill = statusLabel(agent.status);
  if (pill) titleRow.append(node("span", `pill pill-${agent.status}`, pill));
  main.append(titleRow);
  const meta = agentMeta(agent, state.listGroup);
  if (meta) main.append(node("p", "card-meta", meta));
  card.addEventListener("click", () => void openPane(agent.paneId));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openPane(agent.paneId);
    }
  });
  card.append(main, chevron());
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
  } else {
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
  root.append(homeFeedback());
}

function homeFeedback(): HTMLElement {
  const line = node("p", "home-feedback");
  line.append(document.createTextNode("遇到问题？"));
  line.append(issueLink("", "反馈"));
  return line;
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
    const create = button(state.operationBusy ? "新建中" : "新建", "topbar-create", startNewConversation);
    create.disabled = state.operationBusy || !state.live?.isConnected();
    create.setAttribute("aria-label", "新建会话");
    actions.append(create);
  }
  if (state.computers.length > 1) actions.append(button("电脑", "text-link", openComputers));
  actions.append(button("设置", "text-link", openSettings));
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
