import { SNAPSHOT_FALLBACK_MS } from "./poll.ts";

/** No pane read is sent at this cadence; it only avoids a hot idle timer. */
const PANE_TIMER_IDLE_MS = 6_000;

type PollingCallbacks = {
  canRun: () => boolean;
  canReadPane: () => boolean;
  paneDelayMs: () => number;
  refreshSnapshot: () => Promise<void>;
  refreshPane: () => Promise<void>;
};

/** Visible-page fallback polling. Server Pokes still provide the fast path. */
export function createLivePolling(callbacks: PollingCallbacks) {
  let active = false;
  let snapshotTimer: number | null = null;
  let paneTimer: number | null = null;

  const scheduleSnapshot = () => {
    if (!active) return;
    snapshotTimer = window.setTimeout(async () => {
      snapshotTimer = null;
      if (!active) return;
      if (callbacks.canRun()) await callbacks.refreshSnapshot();
      scheduleSnapshot();
    }, SNAPSHOT_FALLBACK_MS);
  };

  const schedulePane = (delay?: number) => {
    if (!active) return;
    paneTimer = window.setTimeout(async () => {
      paneTimer = null;
      if (!active) return;
      if (callbacks.canRun() && callbacks.canReadPane()) await callbacks.refreshPane();
      schedulePane();
    }, delay ?? (callbacks.canReadPane() ? callbacks.paneDelayMs() : PANE_TIMER_IDLE_MS));
  };

  const stop = () => {
    active = false;
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    if (paneTimer !== null) clearTimeout(paneTimer);
    snapshotTimer = null;
    paneTimer = null;
  };

  return {
    start(): void {
      stop();
      if (!callbacks.canRun()) return;
      active = true;
      scheduleSnapshot();
      schedulePane();
    },
    stop,
    wakePane(): void {
      if (!active) return;
      if (paneTimer !== null) clearTimeout(paneTimer);
      paneTimer = null;
      schedulePane(0);
    },
  };
}
