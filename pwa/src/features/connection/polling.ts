import { SNAPSHOT_FALLBACK_MS } from "./poll-schedule";

/** No pane read is sent at this cadence; it only avoids a hot idle timer. */
const PANE_TIMER_IDLE_MS = 6_000;

type PollingCallbacks = {
  canRun: () => boolean;
  canReadPane: () => boolean;
  paneDelayMs: () => number;
  refreshSnapshot: () => Promise<void>;
  refreshPane: () => Promise<void>;
};

type LoopIntent = "none" | "wake" | "defer";

/**
 * Owns at most one timer and one in-flight read. Wake/defer coalesce into the
 * current flight; a bumped generation cannot be restarted by an older callback.
 * An outstanding read Promise outlives stop(); the next generation waits for it
 * instead of overlapping, and that generation's timer is the surviving schedule.
 */
function createOwnedLoop(options: {
  delayMs: () => number;
  shouldRead: () => boolean;
  read: () => Promise<void>;
}) {
  let generation = 0;
  let active = false;
  let timer: number | null = null;
  let inFlight = false;
  let intent: LoopIntent = "none";
  let flight: Promise<void> | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };

  const arm = (delay: number): void => {
    if (!active) return;
    clearTimer();
    const gen = generation;
    timer = window.setTimeout(() => {
      timer = null;
      return run(gen);
    }, delay);
  };

  const run = async (gen: number): Promise<void> => {
    if (gen !== generation || !active || inFlight) return;
    inFlight = true;
    try {
      if (flight) await flight;
      if (gen !== generation || !active) return;
      if (options.shouldRead()) {
        let started: Promise<unknown>;
        try {
          started = Promise.resolve(options.read());
        } catch {
          started = Promise.resolve();
        }
        const mine = started.then(() => undefined, () => undefined);
        flight = mine;
        await mine;
        if (flight === mine) flight = null;
      }
    } catch {
      // Failed reads must not stop fallback or surface as unhandled rejection.
    } finally {
      if (gen === generation) inFlight = false;
    }
    if (gen !== generation || !active) return;
    const delay = intent === "wake" ? 0 : options.delayMs();
    intent = "none";
    arm(delay);
  };

  const stop = (): void => {
    generation += 1;
    active = false;
    // Clear occupancy so a later start can enter run() and wait on `flight`.
    // Do not drop `flight`: overlapping a second read is the restart bug.
    inFlight = false;
    intent = "none";
    clearTimer();
  };

  return {
    start(): void {
      stop();
      active = true;
      arm(options.delayMs());
    },
    stop,
    wake(): void {
      if (!active) return;
      if (inFlight) {
        intent = "wake";
        return;
      }
      arm(0);
    },
    defer(): void {
      if (!active) return;
      if (inFlight) {
        intent = "defer";
        return;
      }
      arm(options.delayMs());
    },
  };
}

/** Visible-page fallback polling. Server Pokes still provide the fast path. */
export function createLivePolling(callbacks: PollingCallbacks) {
  const snapshot = createOwnedLoop({
    delayMs: () => SNAPSHOT_FALLBACK_MS,
    shouldRead: () => callbacks.canRun(),
    read: () => callbacks.refreshSnapshot(),
  });
  const pane = createOwnedLoop({
    delayMs: () => (callbacks.canReadPane() ? callbacks.paneDelayMs() : PANE_TIMER_IDLE_MS),
    shouldRead: () => callbacks.canRun() && callbacks.canReadPane(),
    read: () => callbacks.refreshPane(),
  });

  const stop = (): void => {
    snapshot.stop();
    pane.stop();
  };

  return {
    start(): void {
      stop();
      if (!callbacks.canRun()) return;
      snapshot.start();
      pane.start();
    },
    stop,
    wakePane(): void {
      pane.wake();
    },
    deferPane(): void {
      pane.defer();
    },
  };
}
