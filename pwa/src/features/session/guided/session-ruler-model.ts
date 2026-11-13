/**
 * The session ruler's projection: one tick per row of the herd list, in the
 * order the reader last saw it, plus where the preview card sits under the
 * header. Pure: grouping, identity copy and placement are read from the same
 * inputs the list and the chrome use.
 */
import { groupAgents, type AgentCard, type ListGroup, type PinnedAt, type TouchedAt } from "../../../lib/ranking";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { TabLayoutView } from "../../../lib/layout";
import { herdNeedsReader, paneHeaderLine, paneIdentity } from "../../dashboard/model/herd-view";

export type RulerTick = {
  paneId: string;
  title: string;
  kind: "agent" | "terminal";
  agentKind: string;
  statusLabel: string;
  statusTone: AgentCard["status"];
  line: string;
  /** The list group this row sits in, when that adds something to `line`. */
  group: string;
  /** Its place in that group, and the group's size. */
  groupWithin: number;
  groupCount: number;
  blocked: boolean;
  current: boolean;
};

export type RulerView = {
  ticks: RulerTick[];
  /** -1 when the open pane is not a row of this list. */
  currentIndex: number;
  /** Two rows at least, with the open one among them. */
  visible: boolean;
};

export function rulerView({ agents, listGroup, activation, pinned, currentPaneId, stale }: {
  agents: readonly DashboardAgentCard[];
  listGroup: ListGroup;
  activation: TouchedAt;
  pinned: PinnedAt;
  currentPaneId: string;
  stale: boolean;
}): RulerView {
  const rich = new Map(agents.map((agent) => [agent.paneId, agent]));
  const ticks = groupAgents([...agents], listGroup, activation, pinned).flatMap((group) => group.items.flatMap((item, index) => {
    const agent = rich.get(item.paneId);
    if (!agent) return [];
    const identity = paneIdentity(agent, listGroup, stale);
    const line = paneHeaderLine(identity, agent);
    const groupName = group.id === "all" ? "" : group.title;
    const tick: RulerTick = {
      paneId: agent.paneId,
      title: identity.title,
      kind: identity.kind,
      agentKind: identity.agentKind,
      statusLabel: identity.statusLabel,
      statusTone: identity.statusTone,
      line,
      group: groupName,
      groupWithin: index + 1,
      groupCount: group.items.length,
      // A plain terminal has no agent state, so it never waits on the reader.
      blocked: !stale && herdNeedsReader(agent) === "blocked",
      current: agent.paneId === currentPaneId,
    };
    return [tick];
  }));
  const currentIndex = ticks.findIndex((tick) => tick.current);
  return { ticks, currentIndex, visible: ticks.length >= 2 && currentIndex >= 0 };
}

export type PeekPlacement = { left: number; top: number; width: number };

/** The target's place relative to the session the reader is in. */
export type RulerRelation = "" | "same-tab" | "same-workspace" | "other-workspace";

export function rulerRelation(
  current: { workspaceId?: string; tabId?: string } | null | undefined,
  target: { workspaceId?: string; tabId?: string } | null | undefined,
): RulerRelation {
  if (!current?.workspaceId || !target?.workspaceId || !target.tabId) return "";
  if (current.workspaceId !== target.workspaceId) return "other-workspace";
  if (!current.tabId || current.tabId !== target.tabId) return "same-workspace";
  return "same-tab";
}

export type RulerMapBox = {
  paneId: string;
  current: boolean;
  target: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
};

/** The target's tab as fractional boxes, so the card can draw where both sit. */
export function rulerMapBoxes(layout: TabLayoutView, currentPaneId: string, targetPaneId: string): RulerMapBox[] {
  const { area } = layout;
  if (!area.width || !area.height) return [];
  return layout.panes.map(({ paneId, rect }) => ({
    paneId,
    current: paneId === currentPaneId,
    target: paneId === targetPaneId,
    left: (rect.x - area.x) / area.width,
    top: (rect.y - area.y) / area.height,
    width: rect.width / area.width,
    height: rect.height / area.height,
  }));
}

const CARD_MAX_WIDTH = 322;
const GUTTER = 8;

/** The preview card under the header, centred on its tick and kept in the viewport. */
export function peekPlacement(anchor: { bottom: number }, viewport: { width: number; height: number }, targetCenterX: number): PeekPlacement {
  const width = Math.max(0, Math.min(CARD_MAX_WIDTH, viewport.width - GUTTER * 2));
  const left = Math.min(Math.max(targetCenterX - width / 2, GUTTER), Math.max(GUTTER, viewport.width - width - GUTTER));
  const top = Math.min(Math.max(anchor.bottom + GUTTER, GUTTER), Math.max(GUTTER, viewport.height - GUTTER));
  return { left, top, width };
}
