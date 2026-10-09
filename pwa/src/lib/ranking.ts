import { t } from "./i18n.ts";

export type AgentStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export type DisplayMetadata = {
  displayAgent?: string;
  stateLabels?: Record<string, string>;
  tokens?: Record<string, string>;
  workspaceTokens?: Record<string, string>;
  worktree?: { repo_name: string; checkout_path: string; is_linked_worktree: boolean };
};
export interface AgentCard extends DisplayMetadata {
  paneId: string;
  paneLabel?: string;
  terminalTitle?: string;
  tabId?: string;
  tabLabel?: string;
  workspaceId?: string;
  agent: string;
  status: AgentStatus;
  workspaceLabel: string;
  /** The workspace root the snapshot reports, when it reports one. */
  workspaceCwd?: string;
  cwd: string;
  viewportRows?: number;
  historyAvailable?: boolean;
  terminalId?: string;
  agentInstanceId?: string;
  revision?: number;
  stateChangeSeq?: number;
  interactiveReady?: boolean;
  launchPending?: boolean;
  runtimeSession?: string;
}

export type TouchedAt = Record<string, number>;
export type PinnedAt = Record<string, number>;

export const PINNED_GROUP_ID = "pairfob:pinned";

export function parsePinnedAt(raw: unknown): PinnedAt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: PinnedAt = {};
  for (const [paneId, stamp] of Object.entries(raw as Record<string, unknown>)) {
    if (paneId && typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) out[paneId] = stamp;
  }
  return out;
}

export function paneIsPinned(pinnedAt: PinnedAt, paneId: string): boolean {
  return (pinnedAt[paneId] ?? 0) > 0;
}

export function togglePinnedAt(current: PinnedAt, paneId: string, now = Date.now()): PinnedAt {
  if (!paneId) return current;
  if (paneIsPinned(current, paneId)) {
    const next = { ...current };
    delete next[paneId];
    return next;
  }
  return { ...current, [paneId]: now };
}

export function prunePinnedAt(current: PinnedAt, liveIds: Iterable<string>): PinnedAt {
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const out: PinnedAt = {};
  let changed = false;
  for (const [paneId, stamp] of Object.entries(current)) {
    if (live.has(paneId) && stamp > 0) out[paneId] = stamp;
    else changed = true;
  }
  return changed ? out : current;
}

/**
 * Pinned first, then the most recent stamp. Equal stamps keep the order the
 * computer reported (the sort is stable), so a row never moves without a
 * reason the reader can see.
 */
export function rankAgents(agents: readonly AgentCard[], touchedAt: TouchedAt = {}, pinnedAt: PinnedAt = {}): AgentCard[] {
  return [...agents].sort((a, b) => {
    const pinnedDelta = Number(paneIsPinned(pinnedAt, b.paneId)) - Number(paneIsPinned(pinnedAt, a.paneId));
    if (pinnedDelta !== 0) return pinnedDelta;
    return (touchedAt[b.paneId] ?? 0) - (touchedAt[a.paneId] ?? 0);
  });
}

/** New panes and status changes count as the latest operation. */
export function nextTouchedAt(previous: readonly AgentCard[], next: readonly AgentCard[], current: TouchedAt, now = Date.now()): TouchedAt {
  const prevStatus = new Map(previous.map((agent) => [agent.paneId, agent.status]));
  const live = new Set<string>();
  const out: TouchedAt = { ...current };
  for (const agent of next) {
    live.add(agent.paneId);
    const before = prevStatus.get(agent.paneId);
    if (before === undefined) {
      if (out[agent.paneId] === undefined) out[agent.paneId] = now;
      continue;
    }
    if (before !== agent.status) out[agent.paneId] = now;
  }
  for (const paneId of Object.keys(out)) {
    if (!live.has(paneId)) delete out[paneId];
  }
  return out;
}

export function touchPane(current: TouchedAt, paneId: string, now = Date.now()): TouchedAt {
  if (!paneId) return current;
  return { ...current, [paneId]: now };
}

/**
 * The activation stamps a list that stays on screen is ordered by.
 *
 * Beside the session the list is in view while the reader opens one pane after
 * another; re-sorting it on every open would move the row out from under the
 * pointer. So the order is held as it stood when the list was built (`scope`
 * names that build: the computer, the grouping). A pane that turns up later
 * joins with the stamp it has at that moment and then keeps its place too.
 * Opens still stamp the live record, which the next build adopts.
 */
export type ActivationHold = { scope: string; stamps: TouchedAt; seen: ReadonlySet<string> };

export function holdActivation(
  held: ActivationHold | null,
  scope: string,
  live: TouchedAt,
  paneIds: readonly string[],
): ActivationHold {
  if (!held || held.scope !== scope) return { scope, stamps: { ...live }, seen: new Set(paneIds) };
  const arrived = paneIds.filter((paneId) => !held.seen.has(paneId));
  if (!arrived.length) return held;
  const stamps = { ...held.stamps };
  for (const paneId of arrived) {
    if (live[paneId]) stamps[paneId] = live[paneId];
    else delete stamps[paneId];
  }
  return { scope, stamps, seen: new Set([...held.seen, ...arrived]) };
}

export type ListGroup = "flat" | "space" | "agent";

export type AgentGroup = {
  id: string;
  title: string;
  items: AgentCard[];
};

/** The grouping a list opens with until the user picks another one. */
export const DEFAULT_LIST_GROUP: ListGroup = "space";

export function parseListGroup(raw: string | null | undefined): ListGroup {
  if (raw === "space" || raw === "agent" || raw === "flat") return raw;
  return DEFAULT_LIST_GROUP;
}

function groupKey(agent: AgentCard, mode: Exclude<ListGroup, "flat">): { id: string; title: string } {
  if (mode === "space") {
    const id = agent.workspaceId || agent.workspaceLabel || "space";
    return { id, title: agent.workspaceLabel || t("workspace.unnamed") };
  }
  const name = agent.agent.trim();
  if (!name) return { id: "unbound", title: t("group.unbound") };
  return { id: `agent:${name.toLowerCase()}`, title: name };
}

function groupTouched(group: AgentGroup, touchedAt: TouchedAt): number {
  let latest = 0;
  for (const item of group.items) {
    const stamp = touchedAt[item.paneId] ?? 0;
    if (stamp > latest) latest = stamp;
  }
  return latest;
}

export function groupAgents(
  agents: readonly AgentCard[],
  mode: ListGroup,
  touchedAt: TouchedAt = {},
  pinnedAt: PinnedAt = {},
): AgentGroup[] {
  // `touchedAt` is the reader's own activation: the pane opened last leads its
  // group, and the group holding it leads the list. Ties keep the computer's
  // order, so nothing else — a status change included — moves a row.
  const ranked = rankAgents(agents, touchedAt, pinnedAt);
  const pinnedItems: AgentCard[] = [];
  const rest: AgentCard[] = [];
  for (const agent of ranked) {
    if (paneIsPinned(pinnedAt, agent.paneId)) pinnedItems.push(agent);
    else rest.push(agent);
  }
  const groups: AgentGroup[] = [];
  if (pinnedItems.length) {
    groups.push({ id: PINNED_GROUP_ID, title: t("group.pinned"), items: pinnedItems });
  }
  if (mode === "flat") {
    if (rest.length) groups.push({ id: "all", title: t("group.sessions"), items: rest });
    return groups;
  }
  const buckets = new Map<string, AgentGroup>();
  const order: string[] = [];
  for (const agent of rest) {
    const { id, title } = groupKey(agent, mode);
    let group = buckets.get(id);
    if (!group) {
      group = { id, title, items: [] };
      buckets.set(id, group);
      order.push(id);
    }
    group.items.push(agent);
  }
  return groups.concat(
    order
      .map((id) => {
        const group = buckets.get(id)!;
        return { id: group.id, title: group.title, items: rankAgents(group.items, touchedAt, pinnedAt) };
      })
      .sort((left, right) => {
        const unbound = Number(left.id === "unbound") - Number(right.id === "unbound");
        if (unbound !== 0) return unbound;
        // Equal recency keeps first appearance, i.e. the computer's order.
        return groupTouched(right, touchedAt) - groupTouched(left, touchedAt);
      }),
  );
}

/**
 * Accordion defaults over the group order a list actually displays.
 *
 * The fold belongs to the rendered model: a group that is not on screen has no
 * entry, and "first group open" (two when a pinned section leads) is a property
 * of that order, not of the record.
 */
export function syncCollapsedForIds(
  groupIds: string[],
  current: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  const openCount = groupIds[0] === PINNED_GROUP_ID ? 2 : 1;
  groupIds.forEach((groupId, index) => {
    next[groupId] = current[groupId] ?? index >= openCount;
  });
  return next;
}

export function toggleCollapsedForIds(
  groupIds: string[],
  current: Record<string, boolean>,
  groupId: string,
): Record<string, boolean> {
  const synced = syncCollapsedForIds(groupIds, current);
  if (!groupIds.includes(groupId)) return synced;
  return { ...synced, [groupId]: !synced[groupId] };
}

/** First group starts open; a leading pinned section also leaves the next group open. */
export function syncGroupCollapsed(
  groups: AgentGroup[],
  current: Record<string, boolean>,
): Record<string, boolean> {
  return syncCollapsedForIds(groups.map((group) => group.id), current);
}

export function toggleGroupCollapsed(
  groups: AgentGroup[],
  current: Record<string, boolean>,
  groupId: string,
): Record<string, boolean> {
  return toggleCollapsedForIds(groups.map((group) => group.id), current, groupId);
}
