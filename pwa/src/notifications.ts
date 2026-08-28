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
    showError("这条通知对应的会话已经不在了。");
    render();
    return true;
  }
  await openPane(resolution.paneId);
  return true;
}
