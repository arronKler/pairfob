import { currentDaemonId, currentHerdSession } from "../features/computers/catalog-store";
import { phase } from "../features/connection/connection-store";
import { dashboardStore, liveAgents } from "../features/dashboard/catalog-store";
import { localNotificationsEnabled, refreshLocalPush } from "../features/settings/local-push";
import { t } from "../lib/i18n";
import { nativeNotify, type NativeNotification } from "../lib/native-notify";
import { recordConnectionDiagnostic } from "../lib/protocol/connection-diagnostics";
import { herdSessionScope } from "../lib/protocol/herd-sessions";
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

/**
 * One native notice per pane in one observed scope. Pane ids repeat across
 * computers and Herdr sessions, so the tag folds in the scope. Native bridges
 * cap tag length, so the scope and pane id are hashed to a fixed size.
 */
export function localNoticeTag(scope: string, paneId: string): string {
  let hash = 0xcbf29ce484222325n;
  const input = `${scope}\u0000${paneId}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `pairfob-pane-${hash.toString(16).padStart(16, "0")}`;
}

function noticeFor(agent: DashboardAgentCard, kind: LocalNoticeKind, daemonId: string, tag: string): NativeNotification {
  const title = t(kind === "needs_you" ? "notify.localNeedsYou" : "notify.localDone");
  const who = agent.displayAgent?.trim() || agent.agent.trim() || t("notify.localAgent");
  const body = `${who} · ${paneName(agent)}`.slice(0, 500);
  return {
    title,
    body,
    tag,
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
  type LocalPaneState = { status: string; instance: string; tag: string };
  const scopeOf = (): string | null => {
    const daemonId = currentDaemonId();
    return daemonId === null ? null : herdSessionScope(daemonId, currentHerdSession());
  };
  const paneState = (agent: DashboardAgentCard, paneScope: string): LocalPaneState => ({
    status: agent.status,
    instance: agent.agentInstanceId || "",
    tag: localNoticeTag(paneScope, agent.paneId),
  });
  let scope = scopeOf();
  let previous = new Map<string, LocalPaneState>(
    scope === null ? [] : liveAgents().map((agent) => [agent.paneId, paneState(agent, scope!)]),
  );
  const postedAt = new Map<string, number>();
  const deliveries = new Map<string, Promise<void>>();
  const deliver = (tag: string, action: "post" | "cancel", send: () => Promise<void>) => {
    // Native posting may finish asynchronously (including iOS permission
    // checks). A later cancellation must run after that post has completed.
    const pending = (deliveries.get(tag) ?? Promise.resolve()).then(send).catch((error: unknown) => {
      recordConnectionDiagnostic({ event: `notify_local_${action}`, reason: failureReason(error) });
    });
    deliveries.set(tag, pending);
    void pending.then(() => { if (deliveries.get(tag) === pending) deliveries.delete(tag); });
  };
  const raise = (agent: DashboardAgentCard, kind: LocalNoticeKind, daemonId: string, tag: string) => {
    const notice = noticeFor(agent, kind, daemonId, tag);
    deliver(tag, "post", () => bridge.post(notice));
  };
  const cancel = (tag: string) => {
    // The pane stopped needing the reader. Closing an absent tag is a no-op.
    postedAt.delete(`${tag}\u0000needs_you`);
    deliver(tag, "cancel", () => bridge.cancel(tag));
  };
  const publish = () => {
    const record = dashboardStore.get();
    const nextScope = scopeOf();
    // A retired herd view or another computer/session is not evidence that a
    // pane closed. Pane ids repeat across both, so notices stay with the scope
    // that raised them and the next scope starts from its own first snapshot.
    if (nextScope === null || !record.snapshotLoaded) {
      scope = nextScope;
      previous = new Map();
      return;
    }
    if (nextScope !== scope) {
      scope = nextScope;
      previous = new Map(record.agents.map((agent) => [agent.paneId, paneState(agent, nextScope)]));
      return;
    }
    const daemonId = currentDaemonId();
    const notifying = document.visibilityState === "hidden" && phase() === "live"
      && localNotificationsEnabled();
    const now = Date.now();
    const next = new Map<string, LocalPaneState>();
    for (const agent of record.agents) {
      const state = paneState(agent, nextScope);
      const prior = previous.get(agent.paneId);
      // A replacement occupant is a new episode even while the status stays
      // blocked; the daemon's attention ledger applies the same rule.
      const replacement = prior !== undefined && prior.instance !== "" && state.instance !== ""
        && prior.instance !== state.instance;
      if (state.status === "unknown" && prior && !replacement) {
        // An incomplete observation does not answer the previous wait or
        // create a new episode when the same blocked status returns.
        next.set(agent.paneId, prior);
        continue;
      }
      if (replacement) postedAt.delete(`${state.tag}\u0000needs_you`);
      const kind = replacement
        ? (agent.status === "blocked" ? "needs_you" : null)
        : localNoticeKind(prior?.status, agent.status);
      next.set(agent.paneId, state);
      if (!kind || !notifying || daemonId === null) continue;
      const key = `${state.tag}\u0000${kind}`;
      const last = postedAt.get(key);
      // Record the attempt before posting: a failing bridge must not turn one
      // transition into a burst of retries.
      if (last !== undefined && now - last < LOCAL_PUSH_DEBOUNCE_MS) continue;
      postedAt.set(key, now);
      raise(agent, kind, daemonId, state.tag);
    }
    // A blocked pane that leaves the status leaves no notice behind, whether
    // it was answered, finished or closed. A replacement that is still blocked
    // reuses the tag and replaces the old notice.
    for (const [paneId, prior] of previous) {
      if (prior.status === "blocked" && next.get(paneId)?.status !== "blocked") cancel(prior.tag);
    }
    previous = next;
    const liveTags = new Set<string>();
    for (const state of next.values()) liveTags.add(state.tag);
    for (const [key, last] of postedAt) {
      // Same pruning as the daemon: a gone pane, or an entry older than the
      // window, cannot suppress anything any more.
      if (!liveTags.has(key.slice(0, key.indexOf("\u0000"))) || now - last >= LOCAL_PUSH_DEBOUNCE_MS) {
        postedAt.delete(key);
      }
    }
  };
  const unsubscribe = dashboardStore.subscribe(publish);
  signal.addEventListener("abort", unsubscribe, { once: true });
}
