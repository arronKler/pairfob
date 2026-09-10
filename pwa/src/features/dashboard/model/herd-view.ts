/**
 * Dashboard (home herd list) view model.
 *
 * Pure projection: the builder takes an explicit input snapshot and returns
 * everything the herd screen renders — groups, cards, class lists, copy, gates
 * and the entrance/attention decoration. It never reads the global app state,
 * never touches the DOM, and never consumes attention memory: the caller
 * consumes attention once per paint and hands the resulting marks in.
 */
import { agentMeta, agentTitle, statusLabel, type DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint, StatusMark } from "../../../lib/herd-attention";
import { t } from "../../../lib/i18n";
import {
  groupAgents,
  paneIsPinned,
  PINNED_GROUP_ID,
  type AgentCard,
  type AgentGroup,
  type ListGroup,
  type PinnedAt,
  type TouchedAt,
} from "../../../lib/ranking";
import type { RuntimeLiveness } from "../../../lib/runtime-liveness";
import { emptySessionCopy, type EmptySessionAction } from "../../../lib/ui-model";

/** Status tone vocabulary of the app chrome; core publishes the same union. */
export type HerdTone = "live" | "warn" | "off" | "demo" | "pending";

export type HerdStatus = { tone: HerdTone; text: string };

export type HerdModelInput = {
  /** The published card list; a domain snapshot is read-only by contract. */
  agents: readonly DashboardAgentCard[];
  listGroup: ListGroup;
  paneTouched: TouchedAt;
  panePinned: PinnedAt;
  groupCollapsed: Record<string, boolean>;
  selectedPaneId: string;
  /** Attention consumed once by the paint boundary that built this input. */
  attention: HerdPaint;
  liveness: RuntimeLiveness;
  status: HerdStatus;
  connected: boolean;
  networkOnline: boolean;
  runtimeKind: string;
  createConversation: boolean;
  operationBusy: boolean;
  computerCount: number;
  /** Pane whose title currently shares the view-transition name, if any. */
  morphingPaneId: string | null;
};

export type HerdCardView = {
  paneId: string;
  /** The card the menu actions operate on; refreshed with every projection. */
  agent: AgentCard;
  className: string;
  index: number;
  title: string;
  meta: string;
  pill: { className: string; text: string } | null;
  pinned: boolean;
  pinnedLabel: string;
  selected: boolean;
  sharesTransition: boolean;
};

export type HerdGroupView = {
  id: string;
  title: string;
  count: number;
  index: number;
  collapsed: boolean;
  /** Only a workspace group with a real workspace id owns the heading menu. */
  hasMenu: boolean;
  menuAgent: AgentCard | undefined;
  cards: HerdCardView[];
};

export type HerdEmptyView = {
  title: string;
  sub: string;
  action: { label: string; kind: EmptySessionAction; disabled: boolean } | null;
};

export type HerdViewModel = {
  groups: HerdGroupView[];
  /**
   * Displayed group order. The accordion fold belongs to the model a screen was
   * rendered from, so a toggle carries this instead of re-deriving it from
   * whatever the record holds when the click lands.
   */
  groupIds: string[];
  /** Grouped modes render an accordion; flat renders bare section titles. */
  grouped: boolean;
  /** Replay the card entrance because the list shape changed. */
  stagger: boolean;
  empty: HerdEmptyView | null;
  status: HerdStatus;
  doneCount: number;
  create: { label: string; aria: string; disabled: boolean } | null;
  computers: { label: string } | null;
  board: { label: string };
  settings: { label: string };
};

export function herdCardClassName(input: {
  status: AgentCard["status"];
  stale: boolean;
  selected: boolean;
  pinned: boolean;
  mark: StatusMark;
  dismissing: boolean;
}): string {
  const attention = (input.mark ? (input.mark === "done" ? " ac-changed ac-done" : " ac-changed") : "")
    + (input.dismissing ? " attn-out" : "");
  return `card status-${input.status}${input.stale ? " unverifiable" : ""}${input.selected ? " sel" : ""}`
    + `${input.pinned ? " pinned" : ""}${attention}`;
}

/** Loss of contact never claims a status: the known pill is replaced, not removed. */
export function herdCardPill(status: AgentCard["status"], stale: boolean): { className: string; text: string } | null {
  const text = stale ? t("status.unverifiable") : statusLabel(status);
  if (!text) return null;
  return { className: `pill pill-${stale ? "unknown" : status}`, text };
}

export function herdDoneCount(agents: readonly AgentCard[]): number {
  return agents.filter((agent) => agent.status === "done").length;
}

export function herdEmptyView(input: {
  runtimeKind: string;
  connected: boolean;
  createConversation: boolean;
  networkOnline: boolean;
  operationBusy: boolean;
}): HerdEmptyView {
  const copy = emptySessionCopy(input.runtimeKind, input.connected, input.createConversation, input.networkOnline);
  const action = copy.action ? emptyActionSpec(copy.action, input.operationBusy, input.connected) : null;
  return { title: copy.title, sub: copy.detail, action };
}

export function emptyActionSpec(
  kind: EmptySessionAction,
  operationBusy: boolean,
  connected: boolean,
): { label: string; kind: EmptySessionAction; disabled: boolean } {
  if (kind === "create") return { label: t("empty.actionCreate"), kind, disabled: operationBusy || !connected };
  if (kind === "retry") return { label: t("empty.actionRetry"), kind, disabled: false };
  return { label: t("empty.actionSettings"), kind, disabled: false };
}

function cardView(
  agent: AgentCard,
  input: HerdModelInput,
  index: number,
  stale: boolean,
): HerdCardView {
  const pinned = paneIsPinned(input.panePinned, agent.paneId);
  return {
    paneId: agent.paneId,
    agent,
    className: herdCardClassName({
      status: agent.status,
      stale,
      selected: agent.paneId === input.selectedPaneId,
      pinned,
      mark: input.attention.markOf(agent.paneId),
      dismissing: input.attention.isDismissing(agent.paneId),
    }),
    index,
    title: agentTitle(agent, input.listGroup),
    meta: agentMeta(agent, input.listGroup),
    pill: herdCardPill(agent.status, stale),
    pinned,
    pinnedLabel: t("home.pinned"),
    selected: agent.paneId === input.selectedPaneId,
    sharesTransition: input.morphingPaneId === agent.paneId,
  };
}

/** The heading menu belongs to the first item that really has a workspace. */
export function groupMenuAgent(group: AgentGroup): AgentCard | undefined {
  return group.items.find((item) => item.workspaceId) ?? group.items[0];
}

export function groupHasMenu(listGroup: ListGroup, group: AgentGroup): boolean {
  return listGroup === "space" && group.id !== PINNED_GROUP_ID && Boolean(groupMenuAgent(group)?.workspaceId);
}

/**
 * Project the herd list. Group order, ranking, accordion defaults and the
 * stagger index sequence all come out of one pass so the screen renders exactly
 * what the model says.
 */
export function buildHerdViewModel(input: HerdModelInput): HerdViewModel {
  const groups = groupAgents([...input.agents], input.listGroup, input.paneTouched, input.panePinned);
  const stale = input.liveness === "unverifiable";
  const grouped = input.listGroup !== "flat";
  let position = 0;
  const views = groups.map((group) => {
    const index = position;
    position += group.items.length + 1;
    return {
      id: group.id,
      title: group.title,
      count: group.items.length,
      index,
      collapsed: grouped && input.groupCollapsed[group.id] === true,
      hasMenu: groupHasMenu(input.listGroup, group),
      menuAgent: groupMenuAgent(group),
      cards: group.items.map((agent, offset) => cardView(agent, input, index + offset + 1, stale)),
    };
  });
  return {
    groups: views,
    groupIds: views.map((group) => group.id),
    grouped,
    stagger: input.attention.stagger,
    empty: input.agents.length ? null : herdEmptyView(input),
    status: input.status,
    doneCount: herdDoneCount(input.agents),
    create: input.createConversation
      ? {
          label: input.operationBusy ? t("home.creating") : t("home.new"),
          aria: t("home.newAria"),
          disabled: input.operationBusy || !input.connected,
        }
      : null,
    computers: input.computerCount > 1 ? { label: t("home.computers") } : null,
    board: { label: t("home.board") },
    settings: { label: t("home.settings") },
  };
}
