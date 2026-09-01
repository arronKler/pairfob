import { t } from "./i18n.ts";

export type AgentStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export interface AgentCard {
  paneId: string;
  paneLabel?: string;
  terminalTitle?: string;
  tabId?: string;
  tabLabel?: string;
  workspaceId?: string;
  agent: string;
  status: AgentStatus;
  workspaceLabel: string;
  cwd: string;
  viewportRows?: number;
  historyAvailable?: boolean;
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

export function rankAgents(agents: AgentCard[], touchedAt: TouchedAt = {}, pinnedAt: PinnedAt = {}): AgentCard[] {
  return [...agents].sort((a, b) => {
    const pinnedDelta = Number(paneIsPinned(pinnedAt, b.paneId)) - Number(paneIsPinned(pinnedAt, a.paneId));
    if (pinnedDelta !== 0) return pinnedDelta;
    const delta = (touchedAt[b.paneId] ?? 0) - (touchedAt[a.paneId] ?? 0);
    if (delta !== 0) return delta;
    return a.paneId.localeCompare(b.paneId);
  });
}

/** New panes and status changes count as the latest operation. */
export function nextTouchedAt(previous: AgentCard[], next: AgentCard[], current: TouchedAt, now = Date.now()): TouchedAt {
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

export type ListGroup = "flat" | "space" | "agent";

export type AgentGroup = {
  id: string;
  title: string;
  items: AgentCard[];
};

export function parseListGroup(raw: string | null | undefined): ListGroup {
  if (raw === "space" || raw === "agent") return raw;
  return "flat";
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
  agents: AgentCard[],
  mode: ListGroup,
  touchedAt: TouchedAt = {},
  pinnedAt: PinnedAt = {},
): AgentGroup[] {
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
        const recency = groupTouched(right, touchedAt) - groupTouched(left, touchedAt);
        if (recency !== 0) return recency;
        return left.title.localeCompare(right.title, "zh-CN");
      }),
  );
}

/** First group starts open; a leading pinned section also leaves the next group open. */
export function syncGroupCollapsed(
  groups: AgentGroup[],
  current: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  const openCount = groups[0]?.id === PINNED_GROUP_ID ? 2 : 1;
  groups.forEach((group, index) => {
    next[group.id] = current[group.id] ?? index >= openCount;
  });
  return next;
}

export function toggleGroupCollapsed(
  groups: AgentGroup[],
  current: Record<string, boolean>,
  groupId: string,
): Record<string, boolean> {
  const synced = syncGroupCollapsed(groups, current);
  if (!(groupId in synced)) return synced;
  return { ...synced, [groupId]: !synced[groupId] };
}
