import { t } from "./lib/i18n";
import { resolveNotificationTarget } from "./lib/notification-target";
import { render } from "./paint";
import { showError, state } from "./state";

export async function openPendingNotification(openPane: (paneId: string) => Promise<void>): Promise<boolean> {
  const target = state.notificationTarget;
  if (!target) return false;
  const resolution = resolveNotificationTarget(target, state.credential?.daemonId, state.agents.map((agent) => agent.paneId));
  if (resolution.kind === "wait") return false;
  state.notificationTarget = null;
  if (resolution.kind === "missing") {
    state.screen = "home";
    showError(t("err.notifyGone"));
    render();
    return true;
  }
  await openPane(resolution.paneId);
  return true;
}
