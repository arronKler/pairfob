import { computers, currentDaemonId } from "../features/computers/catalog-store";
import { switchComputer } from "../features/computers/actions";
import { refreshFromSession } from "../features/connection/controller";
import {
  captureNotificationTarget, clearNotificationTarget, connectionStore,
  networkOnline, notificationGeneration, notificationTarget, phase,
} from "../features/connection/connection-store";
import { parseNotificationURL, type NotificationTarget } from "../lib/notification-target";
import { t } from "../lib/i18n";
import { messageOf } from "../lib/notices";
import { showError } from "./notices-store";
import { commitView } from "./host";
import { recordConnectionDiagnostic } from "../lib/protocol/connection-diagnostics";

type NotificationPorts = {
  switchComputer(daemonId: string): Promise<void>;
  refresh(): Promise<void>;
};

/** Page lifetime owns warm links; boot still owns cold links and credential loading. */
export function bindNotificationLinks(signal: AbortSignal, ports: NotificationPorts = {
  switchComputer, refresh: refreshFromSession,
}): void {
  let scheduled = false;
  let busy = false;
  let attempted = notificationGeneration();
  let deferred = "";
  const diagnose = (event: string, reason: string, generation = notificationGeneration()) => {
    recordConnectionDiagnostic({ event, reason, notification_id: generation,
      phase: phase(), hidden: document.visibilityState === "hidden" });
  };
  const wake = () => {
    if (signal.aborted || scheduled || busy) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void drain(); });
  };
  const drain = async () => {
    if (signal.aborted || busy) return;
    const current = phase();
    const target = notificationTarget();
    const generation = notificationGeneration();
    if (!target || attempted === generation) return;
    const waiting = document.visibilityState === "hidden" ? "hidden" : !networkOnline() ? "offline"
      : current === "boot" || current === "resuming" || current === "pairing" ? current : "";
    if (waiting) {
      const key = `${generation}:${waiting}`;
      if (deferred !== key) diagnose("notify_deferred", waiting, generation);
      deferred = key;
      return;
    }
    deferred = "";
    attempted = generation;
    busy = true;
    try {
      if (!computers().some(pair => pair.daemonId === target.daemonId)) {
        diagnose("notify_resolve", "computer_missing", generation);
        clearNotificationTarget();
        if (signal.aborted || notificationGeneration() !== generation) return;
        showError(t("err.notifyComputerGone"), true);
        commitView();
      } else if (current !== "live" || currentDaemonId() !== target.daemonId) {
        diagnose("notify_dispatch", "switch_computer", generation);
        // Establishment obtains a fresh snapshot and consumes the pending link.
        await ports.switchComputer(target.daemonId);
      } else {
        diagnose("notify_dispatch", "refresh", generation);
        // Snapshot consumption also returns named Herdr sessions to default.
        await ports.refresh();
      }
    } catch (error) {
      diagnose("notify_error", "error", generation);
      if (!signal.aborted && notificationGeneration() === generation) {
        showError(messageOf(error));
        commitView();
      }
    } finally {
      diagnose("notify_settled", notificationGeneration() !== generation ? "superseded"
        : notificationTarget() ? "pending" : "consumed", generation);
      busy = false;
      // A newer click arriving during a switch owns the next dispatch.
      if (notificationGeneration() !== generation) wake();
    }
  };
  const capture = (target: NotificationTarget, source: "hashchange" | "worker_message") => {
    captureNotificationTarget(target);
    diagnose("notify_received", source);
    wake();
  };
  window.addEventListener("hashchange", () => {
    const target = parseNotificationURL(location.href, location.origin);
    if (!target) return;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    capture(target, "hashchange");
  }, { signal });
  navigator.serviceWorker?.addEventListener("message", event => {
    if (event.data?.type !== "pairfob_notify") return;
    const target = parseNotificationURL(event.data.url, location.origin);
    if (!target) { diagnose("notify_error", "invalid_target"); return; }
    capture(target, "worker_message");
    // Acknowledging capture lets a new worker fall back for an older page.
    event.ports[0]?.postMessage({ type: "pairfob_notify_captured" });
  }, { signal });
  document.addEventListener("visibilitychange", wake, { signal });
  const unsubscribe = connectionStore.subscribe(wake);
  signal.addEventListener("abort", unsubscribe, { once: true });
}
