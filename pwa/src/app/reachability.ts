/**
 * Phone reachability.
 *
 * The browser's offline signal is only a hint. Android Chrome can keep
 * `navigator.onLine` false after a return from the background while requests
 * still succeed, until the browser process restarts, and the `online` event
 * then never arrives. An offline hint therefore never gates network work by
 * itself: a real origin read confirms it, and while the hint stays offline and
 * the page is visible the read repeats with backoff, so recovery never waits
 * for an event the browser may not send.
 */

export type ReachabilityPorts = {
  /** One real request to the origin; resolves false on any failure. */
  probe: () => Promise<boolean>;
  /** Adopt a confirmed verdict. */
  apply: (available: boolean) => void;
  /** The browser hint: `navigator.onLine !== false`. */
  browserOnline: () => boolean;
  visible: () => boolean;
  /** The hint said offline but the origin answered. */
  onStaleOfflineHint: () => void;
};

export type Reachability = {
  /** A browser network signal arrived (online/offline/visible/pageshow). */
  report: () => void;
  /** The page went hidden: stop re-checking until it is visible again. */
  pause: () => void;
  release: () => void;
};

const FIRST_RECHECK_MS = 1500;
const MAX_RECHECK_MS = 15000;

export function createReachability(ports: ReachabilityPorts): Reachability {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = FIRST_RECHECK_MS;
  let released = false;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const check = async (): Promise<void> => {
    if (released) return;
    const owner = generation;
    const reachable = await ports.probe();
    // A newer signal (or a release) owns the verdict now; its own read decides.
    if (released || owner !== generation) return;
    if (reachable) {
      delay = FIRST_RECHECK_MS;
      ports.onStaleOfflineHint();
      ports.apply(true);
      return;
    }
    ports.apply(false);
    if (!ports.visible()) return;
    timer = setTimeout(() => {
      timer = null;
      if (!released && owner === generation && !ports.browserOnline() && ports.visible()) void check();
    }, delay);
    delay = Math.min(delay * 2, MAX_RECHECK_MS);
  };

  return {
    report(): void {
      if (released) return;
      generation += 1;
      clearTimer();
      if (ports.browserOnline()) {
        delay = FIRST_RECHECK_MS;
        ports.apply(true);
        return;
      }
      if (!ports.visible()) return;
      void check();
    },
    pause(): void {
      generation += 1;
      clearTimer();
    },
    release(): void {
      released = true;
      generation += 1;
      clearTimer();
    },
  };
}
