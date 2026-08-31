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

export function rankAgents(agents: AgentCard[], touchedAt: TouchedAt = {}): AgentCard[] {
  return [...agents].sort((a, b) => {
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

export function groupAgents(agents: AgentCard[], mode: ListGroup, touchedAt: TouchedAt = {}): AgentGroup[] {
  const ranked = rankAgents(agents, touchedAt);
  if (mode === "flat") {
    return ranked.length ? [{ id: "all", title: t("group.sessions"), items: ranked }] : [];
  }
  const groups = new Map<string, AgentGroup>();
  const order: string[] = [];
  for (const agent of ranked) {
    const { id, title } = groupKey(agent, mode);
    let group = groups.get(id);
    if (!group) {
      group = { id, title, items: [] };
      groups.set(id, group);
      order.push(id);
    }
    group.items.push(agent);
  }
  return order
    .map((id) => {
      const group = groups.get(id)!;
      return { id: group.id, title: group.title, items: rankAgents(group.items, touchedAt) };
    })
    .sort((left, right) => {
      const unbound = Number(left.id === "unbound") - Number(right.id === "unbound");
      if (unbound !== 0) return unbound;
      const recency = groupTouched(right, touchedAt) - groupTouched(left, touchedAt);
      if (recency !== 0) return recency;
      return left.title.localeCompare(right.title, "zh-CN");
    });
}

/** First group starts open; later groups start collapsed. Known ids keep their last choice. */
export function syncGroupCollapsed(
  groups: AgentGroup[],
  current: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  groups.forEach((group, index) => {
    next[group.id] = current[group.id] ?? index > 0;
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
