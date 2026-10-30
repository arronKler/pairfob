import { useSyncExternalStore } from "react";
import { dashboardStore, herdAgentsKey } from "./catalog-store";

const herdAgentsSnapshotKey = () => herdAgentsKey(dashboardStore.get());

/**
 * The herd list, for a screen that draws the rows.
 *
 * The list's signature is the subscription: the domain also publishes for a
 * refresh flag, a board camera move or the open pane's own card, and none of
 * those changes a row. A publish that leaves the signature alone bails out in
 * `useSyncExternalStore` instead of rebuilding the list.
 */
export function useAgents() {
  useSyncExternalStore(dashboardStore.subscribe, herdAgentsSnapshotKey, herdAgentsSnapshotKey);
  return dashboardStore.get().agents;
}

/**
 * The dashboard card of one pane.
 *
 * The herd list's own signature is the subscription, not the snapshot: a
 * published snapshot copies every card, so the card object alone would change
 * identity on a refresh flag or a board camera move. While the signature holds,
 * the card is read from the same snapshot the last render used.
 */
export function useAgentCard(paneId: string) {
  useSyncExternalStore(dashboardStore.subscribe, herdAgentsSnapshotKey, herdAgentsSnapshotKey);
  return dashboardStore.get().agents.find((agent) => agent.paneId === paneId);
}
