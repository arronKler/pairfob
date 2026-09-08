import { appendDaemonUpdate } from "./daemon-update";
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
import { openHerdPaint, type HerdPaint } from "../lib/herd-attention";
import { emptySessionCopy, type EmptySessionAction } from "../lib/ui-model";
import { openComputers } from "../computers";
import { openPane, reconnectLiveSessions } from "../live";
import { startNewConversation } from "../live-operations";
import { openSettings } from "../live-settings";
import { render } from "../paint";
import { app, haptic, state, type StatusTone } from "../state";
import { openBoard } from "./board";
import {
  appendNotice,
  brandNode,
  chevron,
  completionCountNode,
  emptyNode,
  type EmptySpec,
  groupToggle,
  herdBanners,
  herdLiveness,
  herdStatus,
  listGroupControl,
  sectionTitle,
  statusLineNode,
} from "./chrome";
import { openListPaneMenu, openListWorkspaceMenu } from "./list-menu";
import { bindObjectPress } from "./press-menu";
import { worktreeProgressList } from "./worktree-progress";
import { morphingPane, shareTitle } from "./transition";

export function agentCard(agent: AgentCard, paint?: HerdPaint, index = 0): HTMLElement {
  const selected = agent.paneId === state.paneId;
  const pinned = paneIsPinned(state.panePinned, agent.paneId);
  const title = agentTitle(agent, state.listGroup);
  // Unverifiable snapshots keep their cards but never paint last-known
  // done/idle as a fresh fact.
  const stale = herdLiveness() === "unverifiable";
  const mark = paint?.markOf(agent.paneId) ?? "";
  const attention = [
    mark === "" ? "" : mark === "done" ? " ac-changed ac-done" : " ac-changed",
    paint?.isDismissing(agent.paneId) ? " attn-out" : "",
  ].join("");
  const card = node("article", `card status-${agent.status}${stale ? " unverifiable" : ""}${selected ? " sel" : ""}${pinned ? " pinned" : ""}${attention}`);
  // Drives both the entrance delay and the breathing phase, so several waiting
  // completions do not blink in unison.
  card.style.setProperty("--i", String(index));
  const main = button("", "card-main", () => {
    // Tag before navigating: the outgoing snapshot is this DOM as it stands.
    shareTitle(titleRow);
    void openPane(agent.paneId);
  });
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
  // Coming back out of a pane, this card is the other half of the morph.
  if (morphingPane() === agent.paneId) shareTitle(titleRow);
  const pill = stale ? t("status.unverifiable") : statusLabel(agent.status);
  if (pill) titleRow.append(node("span", `pill pill-${stale ? "unknown" : agent.status}`, pill));
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

/** The empty state names what to do; wiring it up stays out of lib/ui-model. */
function emptyAction(kind: EmptySessionAction | undefined): EmptySpec["action"] {
  if (kind === "create") {
    return {
      label: t("empty.actionCreate"),
      run: startNewConversation,
      disabled: state.operationBusy || !state.live?.isConnected(),
    };
  }
  if (kind === "retry") return { label: t("empty.actionRetry"), run: () => reconnectLiveSessions("probe") };
  if (kind === "settings") return { label: t("empty.actionSettings"), run: openSettings };
  return undefined;
}

export function fillHerdList(root: HTMLElement): void {
  appendDaemonUpdate(root);
  const jobCards = worktreeProgressList();
  if (jobCards) root.append(jobCards);
  root.append(listGroupControl());
  if (!state.agents.length) {
    const copy = emptySessionCopy(
      state.runtimeKind,
      state.live?.isConnected() === true,
      state.operationCapabilities.create_conversation,
      state.networkOnline,
    );
    root.append(emptyNode({ title: copy.title, sub: copy.detail, figure: "panes", action: emptyAction(copy.action) }));
    return;
  }
  const paint = openHerdPaint(state.agents, state.listGroup);
  // One acknowledgement for the batch: a herd that finishes three panes at once
  // should not buzz three times.
  if (paint.completed.length && document.visibilityState === "visible") haptic(14);
  const groups = groupAgents(state.agents, state.listGroup, state.paneTouched, state.panePinned);
  const list = node("div", `herd-list${paint.stagger ? " enter" : ""}`);
  // One running index down the whole list, so the entrance reads as a single
  // top-down sweep whether or not the herd is grouped.
  let position = 0;
  const step = (element: HTMLElement) => {
    element.style.setProperty("--i", String(position++));
    return element;
  };
  if (state.listGroup === "flat") {
    for (const group of groups) {
      list.append(step(sectionTitle(group.title, group.items.length)));
      group.items.forEach((agent) => list.append(agentCard(agent, paint, position++)));
    }
  } else {
    state.listGroupCollapsed = syncGroupCollapsed(groups, state.listGroupCollapsed);
    for (const group of groups) list.append(herdGroup(group, groups, paint, step, () => position++));
  }
  root.append(list);
}

function herdGroup(
  group: AgentGroup,
  groups: AgentGroup[],
  paint: HerdPaint,
  step: (element: HTMLElement) => HTMLElement,
  next: () => number,
): HTMLElement {
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
  section.append(step(heading));
  const body = node("div", "herd-group-body");
  body.hidden = collapsed;
  group.items.forEach((item) => body.append(agentCard(item, paint, next())));
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
  actions.append(button(t("home.board"), "text-link", () => void openBoard()));
  actions.append(button(t("home.settings"), "text-link", openSettings));
  return actions;
}

/** Displayed status stays "done" only while the completion is unacknowledged. */
function unreadCompletions(): number {
  return state.agents.filter((agent) => agent.status === "done").length;
}

function statusLine(status: { tone: StatusTone; text: string }): HTMLElement {
  const line = statusLineNode(status);
  const count = completionCountNode(unreadCompletions());
  if (count) line.append(count);
  return line;
}

/** The home screen as a detached tree, so a gesture can show it under the pane. */
export function homePage(): HTMLElement {
  const status = herdStatus();
  const root = node("div", "page");
  const top = node("div", "topbar");
  top.append(brandNode(status.tone, true), liveActions());
  root.append(top, statusLine(status));
  herdBanners(root, status);
  appendNotice(root);
  fillHerdList(root);
  return root;
}

export function renderHome(): void {
  app.replaceChildren(homePage());
}

export function renderRail(): HTMLElement {
  const status = herdStatus();
  const rail = node("aside", "rail");
  const top = node("div", "topbar");
  top.append(brandNode(status.tone, true), liveActions());
  rail.append(top, statusLine(status));
  herdBanners(rail, status);
  fillHerdList(rail);
  return rail;
}
