/**
 * Dashboard page bridge.
 *
 * Owns the two things that must not happen inside a React render, and the reads
 * the route takes from the approved domains:
 *
 * 1. Attention is consumed exactly once per presentation (`openHerdPaint`
 *    remembers the previous statuses), and a completion batch vibrates once, only
 *    while the document is visible. The result is published through a small
 *    store, so a self-subscribed page renders the marks the paint boundary
 *    consumed — React never consumes attention itself.
 * 2. The accordion defaults are reconciled through the typed preferences action,
 *    and only when the reconciled map really differs, so a presentation that
 *    changes nothing publishes nothing.
 *
 * Every write here is a typed domain action (`preferences.setListGroupCollapsed`),
 * so a mounted herd list updates from its own subscription and no manual repaint
 * is requested. Reads come from the domains' live canonical readers and published
 * snapshots; the App commit pipeline (`app/commit.ts`) owns publication, so the
 * presentation never flushes.
 *
 * Presentation (`features/dashboard`) and the pure models never import this file.
 */
import { capabilityEnabled, operationBusy } from "../../features/operations/capabilities-store";
import { computersStore, liveSession } from "../../features/computers/catalog-store";
import { networkOnline } from "../../features/connection/connection-store";
import { dashboardStore, liveAgents } from "../../features/dashboard/catalog-store";
import { listGroup, listGroupCollapsed, panePinned, paneTouched, preferencesStore, setListGroupCollapsed } from "../../features/settings/preferences-store";
import { runtimeStore } from "../../features/connection/runtime-store";
import { openPaneId } from "../../features/session/session-store";
import type { HerdActionPorts } from "../../features/dashboard/actions";
import type { DashboardAgentCard } from "../../lib/dashboard";
import type { HerdPaint, StatusMark } from "../../lib/herd-attention";
import { openHerdPaint } from "../../lib/herd-attention";
import { groupAgents, syncGroupCollapsed, toggleCollapsedForIds } from "../../lib/ranking";
import { haptic } from "../../shared/ui/dom/feedback";
import { herdLivenessModel, herdStatusModel } from "../../features/dashboard/model/herd-status";
import { buildHerdViewModel, type HerdModelInput, type HerdViewModel } from "../../features/dashboard/model/herd-view";
import { morphingPane, shareTitle } from "../../app/transition";
import { openBoard } from "../board/board-bridge";
import { openListPaneMenu, openListWorkspaceMenu } from "./object-menu";

/** Completion acknowledgement for a batch that just landed, while visible. */
const COMPLETION_HAPTIC_MS = 14;

const NO_ATTENTION: HerdPaint = Object.freeze({
  stagger: false,
  markOf: (): StatusMark => "",
  isDismissing: () => false,
  completed: Object.freeze([]) as unknown as string[],
});

let attention = NO_ATTENTION;
const attentionListeners = new Set<() => void>();

/**
 * Detach one presentation's marks from the live attention maps. `openHerdPaint`
 * closes over mutable module state, so a retained paint would otherwise start
 * reporting a later presentation's marks without a new snapshot or notify.
 */
function freezeHerdPaint(paint: HerdPaint, agents: readonly DashboardAgentCard[]): HerdPaint {
  const marks: Record<string, StatusMark> = Object.create(null);
  const dismissing: Record<string, boolean> = Object.create(null);
  for (const agent of agents) {
    marks[agent.paneId] = paint.markOf(agent.paneId);
    dismissing[agent.paneId] = paint.isDismissing(agent.paneId);
  }
  return Object.freeze({
    stagger: paint.stagger,
    completed: Object.freeze(paint.completed.slice()) as unknown as string[],
    markOf: (paneId: string): StatusMark => marks[paneId] ?? "",
    isDismissing: (paneId: string) => dismissing[paneId] === true,
  });
}

export function subscribeHerdAttention(listener: () => void): () => void {
  attentionListeners.add(listener);
  return () => {
    attentionListeners.delete(listener);
  };
}

/** The attention the last presentation consumed; stable until the next change. */
export function readHerdAttention(): HerdPaint {
  return attention;
}

/** Test seam: forget the consumed attention so a suite starts unseen. */
export function resetHerdAttentionSnapshot(): void {
  attention = NO_ATTENTION;
}

function attentionSignature(paint: HerdPaint, agents: readonly DashboardAgentCard[]): string {
  const marks = agents.map((agent) => `${agent.paneId}:${paint.markOf(agent.paneId)}:${paint.isDismissing(agent.paneId)}`);
  return `${paint.stagger}\u0000${paint.completed.join(",")}\u0000${marks.join(",")}`;
}

function sameCollapsed(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * Everything the herd projection reads, from the domains that own it. Called
 * during render, so it mutates nothing: the presentation boundary below is where
 * attention is consumed and accordion defaults are reconciled.
 */
export function readHerdInput(painted: HerdPaint): HerdModelInput {
  const dashboard = dashboardStore.get();
  const preferences = preferencesStore.get();
  const computers = computersStore.get();
  const runtime = runtimeStore.get();
  const connected = liveSession()?.isConnected() === true;
  const online = networkOnline();
  const reachability = { connected, networkOnline: online, runtimeKind: runtime.runtimeKind };
  return {
    agents: dashboard.agents,
    listGroup: listGroup(),
    paneTouched: preferences.paneTouched,
    panePinned: preferences.panePinned,
    groupCollapsed: preferences.listGroupCollapsed,
    selectedPaneId: openPaneId(),
    attention: painted,
    liveness: herdLivenessModel(reachability),
    status: herdStatusModel({ ...reachability, herdHost: runtime.herdHost }),
    connected,
    networkOnline: online,
    runtimeKind: runtime.runtimeKind,
    createConversation: capabilityEnabled("create_conversation"),
    operationBusy: operationBusy(),
    computerCount: computers.computers.length,
    morphingPaneId: morphingPane(),
  };
}

/**
 * Consume attention, acknowledge a visible completion batch, reconcile the
 * accordion defaults and project the herd view model. Called once per paint by
 * the imperative boundary — never from inside a React render.
 */
export function presentHerdView(): HerdViewModel {
  // Action-time boundary: read the live owner records, not the published
  // snapshots, so a typed action that landed since the last commit is visible
  // here. React projections keep using readHerdInput's stable snapshots.
  const agents = liveAgents();
  const group = listGroup();
  const consumed = openHerdPaint([...agents], group);
  if (consumed.completed.length && document.visibilityState === "visible") haptic(COMPLETION_HAPTIC_MS);
  if (group !== "flat") {
    const groups = groupAgents([...agents], group, paneTouched(), panePinned());
    const collapsed = listGroupCollapsed();
    const synced = syncGroupCollapsed(groups, collapsed);
    if (!sameCollapsed(synced, collapsed)) setListGroupCollapsed(synced);
  }
  const snapshot = freezeHerdPaint(consumed, agents);
  // Publish only when a subscriber would render something different. Comparison
  // uses the captured marks, not the live closures, so idle→working is visible.
  if (attentionSignature(snapshot, agents) !== attentionSignature(attention, agents)) {
    attention = snapshot;
    for (const listener of [...attentionListeners]) listener();
  }
  return buildHerdViewModel(readHerdInput(attention));
}

/**
 * Collapse or open one group of the list the reader clicked. `groupIds` is that
 * rendered list's order, so a fold never reaches a group the screen does not show
 * and never drops one it does.
 *
 * The typed action publishes and the subscribed route re-renders: no repaint is
 * requested, on the phone page or in the desktop rail.
 */
export function toggleHerdGroup(groupId: string, groupIds: string[]): void {
  setListGroupCollapsed(toggleCollapsedForIds(groupIds, listGroupCollapsed(), groupId));
}

export function herdActionPorts(): HerdActionPorts {
  return {
    // Read when the press lands: a hold that began while idle must still be
    // refused once a mutation is in flight or the session dropped.
    canOpenMenu: () => !operationBusy() && liveSession()?.isConnected() === true,
    toggleGroup: toggleHerdGroup,
    openBoard: () => {
      void openBoard();
    },
    shareTitle,
    openPaneMenu: openListPaneMenu,
    openWorkspaceMenu: openListWorkspaceMenu,
  };
}
