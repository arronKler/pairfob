import { useSyncExternalStore } from "react";
import { computersStore, liveSession } from "../../features/computers/catalog-store";
import { goToScreen } from "../../app/navigation-store";
import { commitView } from "../../app/host";
import { refreshAgentQuota } from "../../features/agent-quota/actions";
import { quotaPanelModel } from "../../features/agent-quota/model";
import { QuotaPanelView } from "../../features/agent-quota/quota-panel-view";
import { quotaSnapshot, subscribeQuota } from "../../features/agent-quota/store";
import { t } from "../../lib/i18n";
import type { LiveSession } from "../../lib/protocol/session-types";
import { BackBar, Button } from "../../shared/ui/primitives";

/**
 * Quota page composition.
 *
 * Two subscriptions, both narrow: the computers domain for the established
 * session, and the quota snapshot store for that session's data. A refresh
 * repaints this subtree on its own and never needs the global paint loop.
 *
 * The session snapshot uses the canonical `liveSession()` reader and subscribes
 * to the computers store. Attach/detach publications update the mounted panel.
 *
 * Back commits through the application port (`commitView`), so the installed
 * App composes the arriving settings screen synchronously; ordinary data
 * updates stay on the page's own domain subscriptions.
 */

/** Established session: computers subscription + action-time live-record read. */
export function useEstablishedSession(): LiveSession | null {
  return useSyncExternalStore(computersStore.subscribe, liveSession);
}

function useQuotaPanel() {
  const session = useEstablishedSession();
  const snapshot = useSyncExternalStore(subscribeQuota, () => quotaSnapshot(session));
  return quotaPanelModel(snapshot, session?.isConnected() === true);
}

export function QuotaPanel() {
  return <QuotaPanelView panel={useQuotaPanel()} />;
}

export function QuotaContent() {
  const session = useEstablishedSession();
  const snapshot = useSyncExternalStore(subscribeQuota, () => quotaSnapshot(session));
  const panel = quotaPanelModel(snapshot, session?.isConnected() === true);
  const loading = !!snapshot?.loading;
  return (
    <>
      <BackBar
        title={t("quota.title")}
        onBack={() => {
          goToScreen("settings");
          commitView();
        }}
      >
        <div className="topbar-actions">
          <Button
            className="topbar-create quota-refresh"
            disabled={loading || session?.isConnected() !== true}
            aria-busy={loading}
            onClick={() => void refreshAgentQuota()}
          >{t(loading ? "quota.loading" : "quota.refresh")}</Button>
        </div>
      </BackBar>
      <QuotaPanelView panel={panel} />
    </>
  );
}

export function QuotaScreen() {
  return (
    <div className="page settings-page quota-page">
      <QuotaContent />
    </div>
  );
}
