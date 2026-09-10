import { liveSession } from "../computers/catalog-store";
import { goToScreen } from "../../app/navigation-store";
import { t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/errors";
import { commitView } from "../../app/host";
import { quotaSnapshot, setQuotaSnapshot } from "./store";

/**
 * Quota controller — the feature's one connected adapter.
 *
 * It reads the computers domain for the established session and navigates
 * through the navigation action.
 *
 * Data updates deliberately do NOT repaint the app: the snapshot store notifies
 * its own subscribers, so a mounted quota page or settings summary refreshes on
 * its own — and a refresh that finishes after a computer switch notifies nobody
 * who is looking at it, because the answer landed on the retired session.
 *
 * Navigation commits through the application port (`commitView`): the installed
 * App composes the arriving screen synchronously. With no host installed the
 * controller is headless and mounts nothing.
 */

/** In-flight read guard: one outstanding quota request per session. */
function alreadyLoading(): boolean {
  const session = liveSession();
  return !!session && quotaSnapshot(session)?.loading === true;
}

export async function refreshAgentQuota(): Promise<void> {
  const session = liveSession();
  if (!session || !session.isConnected() || alreadyLoading()) return;
  const previous = quotaSnapshot(session);
  setQuotaSnapshot(session, { loading: true, items: previous?.items ?? null, error: "" });
  try {
    const items = await session.agentQuota();
    setQuotaSnapshot(session, { loading: false, items, error: "" });
  } catch (error) {
    setQuotaSnapshot(session, {
      loading: false,
      items: null,
      error: t(error instanceof ProtocolError && error.code === "unknown_op" ? "quota.upgrade" : "quota.failed"),
    });
  }
}

/** Navigation, so it repaints through the application port: the quota page has to be composed first. */
export function openQuota(): void {
  goToScreen("quota");
  commitView();
  void refreshAgentQuota();
}
