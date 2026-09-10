import { useSyncExternalStore } from "react";
import { openQuota } from "../../features/agent-quota/actions";
import { quotaSummaryModel } from "../../features/agent-quota/model";
import { QuotaSummaryView } from "../../features/agent-quota/quota-summary-view";
import { quotaSnapshot, subscribeQuota } from "../../features/agent-quota/store";
import { useEstablishedSession } from "./quota-page";

/**
 * The quota summary surface the settings page composes.
 *
 * Same session contract as the quota page: subscribe to the computers domain so
 * typed attach/detach updates a mounted summary without paint, and read the
 * live record so an unpublished facade attach is visible on the next render.
 */
export function AgentQuotaSummary() {
  const session = useEstablishedSession();
  const snapshot = useSyncExternalStore(subscribeQuota, () => quotaSnapshot(session));
  return <QuotaSummaryView summary={quotaSummaryModel(snapshot, session?.isConnected() === true)} onOpenDetails={openQuota} />;
}
