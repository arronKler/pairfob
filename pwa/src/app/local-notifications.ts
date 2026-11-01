import { currentDaemonId } from "../features/computers/catalog-store";
import { phase } from "../features/connection/connection-store";
import { dashboardStore, liveAgents } from "../features/dashboard/catalog-store";
import { localNotificationsEnabled, refreshLocalPush } from "../features/settings/local-push";
import { t } from "../lib/i18n";
import { nativeNotify, type NativeNotification } from "../lib/native-notify";
import { recordConnectionDiagnostic } from "../lib/protocol/connection-diagnostics";
import type { DashboardAgentCard } from "../lib/dashboard";

/** The daemon's own push kinds, so an Android notice matches a Web Push one. */
export type LocalNoticeKind = "needs_you" | "done";

export const LOCAL_PUSH_DEBOUNCE_MS = 30_000;

/**
 * The transition rule from `internal/daemon/push.go`: a status the previous
 * snapshot knew, that changed, into blocked or working -> done.
 */
export function localNoticeKind(previous: string | undefined, current: string): LocalNoticeKind | null {
  if (previous === undefined || previous === current) return null;
  if (current === "blocked") return "needs_you";
  if (previous === "working" && current === "done") return "done";
  return null;
}

function paneName(agent: DashboardAgentCard): string {
  const label = agent.paneLabel?.trim() || agent.workspaceLabel?.trim();
  if (label) return label;
  return agent.paneId.length > 8 ? agent.paneId.slice(-8) : agent.paneId;
}

function noticeFor(agent: DashboardAgentCard, kind: LocalNoticeKind, daemonId: string): NativeNotification {
  const title = t(kind === "needs_you" ? "notify.localNeedsYou" : "notify.localDone");
  const who = agent.displayAgent?.trim() || agent.agent.trim() || t("notify.localAgent");
  const body = `${who} · ${paneName(agent)}`.slice(0, 500);
  return {
    title,
    body,
    // One tag per pane: a completion replaces a stale needs-you notice, as the
    // daemon's Web Push tag does.
    tag: `pairfob-pane-${agent.paneId}`,
    url: `/pair#notify=1&d=${encodeURIComponent(daemonId)}&pane=${encodeURIComponent(agent.paneId)}`,
  };
}

function failureReason(error: unknown): string {
  return error instanceof Error && /timed out/.test(error.message) ? "timeout" : "failed";
}

/**
 * Raise local notifications from the live dashboard catalog. The daemon pokes
 * the page, the background lane folds the Snapshot, and this watcher turns the
 * resulting status transitions into system notices. A visible page already
 * shows the in-app attention strip, so only a hidden one notifies.
 */
export function bindLocalNotifications(signal: AbortSignal): void {
  const bridge = nativeNotify();
  if (!bridge) return;
  const settleBackgroundSync = async () => {
    // The connection lane reads background sync from this cache before it decides to
    // follow a poke while hidden, so read it at bind time.
    const status = await refreshLocalPush();
    if (!status || status.backgroundSync || status.permission !== "granted" || !localNotificationsEnabled()) return;
    // An update or a reboot can drop the persisted job while the choice stays
    // on; the hidden attention lane depends on the schedule coming back.
    if (await bridge.setBackgroundSync(true).catch(() => false)) await refreshLocalPush();
  };
  void settleBackgroundSync().catch(() => undefined);
  let previous = new Map(liveAgents().map((agent) => [agent.paneId, agent.status]));
  const postedAt = new Map<string, number>();
  const raise = (agent: DashboardAgentCard, kind: LocalNoticeKind, daemonId: string) => {
    void bridge.post(noticeFor(agent, kind, daemonId)).catch((error: unknown) => {
      recordConnectionDiagnostic({ event: "notify_local_post", reason: failureReason(error) });
    });
  };
  const publish = () => {
    const agents = liveAgents();
    const daemonId = currentDaemonId();
    const notifying = document.visibilityState === "hidden" && phase() === "live"
      && localNotificationsEnabled();
    const now = Date.now();
    const next = new Map<string, DashboardAgentCard["status"]>();
    for (const agent of agents) {
      next.set(agent.paneId, agent.status);
      const kind = localNoticeKind(previous.get(agent.paneId), agent.status);
      if (!kind || !notifying || daemonId === null) continue;
      const key = `${agent.paneId}\u0000${kind}`;
      const last = postedAt.get(key);
      // Record the attempt before posting: a failing bridge must not turn one
      // transition into a burst of retries.
      if (last !== undefined && now - last < LOCAL_PUSH_DEBOUNCE_MS) continue;
      postedAt.set(key, now);
      raise(agent, kind, daemonId);
    }
    previous = next;
    for (const [key, last] of postedAt) {
      // Same pruning as the daemon: a gone pane, or an entry older than the
      // window, cannot suppress anything any more.
      if (!next.has(key.slice(0, key.indexOf("\u0000"))) || now - last >= LOCAL_PUSH_DEBOUNCE_MS) {
        postedAt.delete(key);
      }
    }
  };
  const unsubscribe = dashboardStore.subscribe(publish);
  signal.addEventListener("abort", unsubscribe, { once: true });
}
