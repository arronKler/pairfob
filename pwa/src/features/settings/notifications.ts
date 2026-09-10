import { commitView } from "../../app/host";
import { currentDaemonId, liveSession } from "../computers/catalog-store";
import {
  clearNotificationTarget, notificationGeneration, notificationTarget,
} from "../connection/connection-store";
import { liveAgents } from "../dashboard/catalog-store";
import { goToScreen } from "../../app/navigation-store";
import { showError } from "../../app/notices-store";
import { t } from "../../lib/i18n";
import type { NotificationTarget } from "../../lib/notification-target";
import { resolveNotificationTarget } from "../../lib/notification-target";

/**
 * Notification deep link handling.
 *
 * The intent generation, its target and its owner computer/session are captured
 * before any publication. Every step below — clearing the target, the
 * missing-target navigation — publishes, and a subscriber reacting there can
 * open a newer link (same computer or another) or replace the owner. The
 * continuation revalidates the captured generation and owner after each
 * publication: an older intent never opens its pane, never navigates, and never
 * shows its gone-notice once a newer intent or a replacement owner exists. The
 * newer consumption owns its own pane/notice; clearing does not mint an intent.
 */
export async function openPendingNotification(openPane: (paneId: string) => Promise<void>): Promise<boolean> {
  const target = notificationTarget();
  if (!target) return false;
  const generation = notificationGeneration();
  const ownerDaemonId = currentDaemonId();
  const ownerSession = liveSession();
  const resolution = resolveNotificationTarget(
    target,
    ownerDaemonId ?? undefined,
    liveAgents().map((agent) => agent.paneId),
  );
  if (resolution.kind === "wait") return false;
  const captured: NotificationTarget = { daemonId: target.daemonId, paneId: target.paneId };
  // True while this consumption is still the newest intent for the owner it
  // captured. A newer deep link — even a same-computer replacement — advances
  // the generation; an owner switch replaces the session/daemon.
  const stillCurrent = () =>
    notificationGeneration() === generation &&
    currentDaemonId() === captured.daemonId &&
    liveSession() === ownerSession;
  clearNotificationTarget();
  if (!stillCurrent()) return true;
  if (resolution.kind === "missing") {
    const stillMissing = !liveAgents().some((agent) => agent.paneId === captured.paneId);
    if (stillMissing) {
      goToScreen("home");
      // The home navigation publishes: a replacement that takes over there
      // owns the screen and its notice, so the gone-notice and its commit must
      // not land over it.
      if (!stillCurrent()) return true;
      showError(t("err.notifyGone"));
      commitView();
    }
    return true;
  }
  await openPane(captured.paneId);
  return true;
}
