import type { DashboardRecord } from "../dashboard/catalog-store";
import type { Immutable } from "../../shared/model/domain-store";

/**
 * Card of the open pane from a published dashboard snapshot.
 * Do not use detached selectedAgent() as a React getSnapshot — it allocates a
 * new object every call. store.get() stays stable until the domain publishes.
 */
export function agentFromDashboardSnapshot(
  dashboard: Immutable<DashboardRecord>,
  paneId: string,
): Immutable<DashboardRecord>["agents"][number] | undefined {
  return dashboard.agents.find((agent) => agent.paneId === paneId);
}
