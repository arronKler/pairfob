export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

/**
 * The relay refused a dial because no daemon was attached. Nothing at the relay
 * changes until the computer comes back, and no phone that is not connected is
 * told when it does, so the session keeps one slow dial a minute. Parking until
 * a wake would strand a computer that comes back while the phone is open.
 */
export const DAEMON_OFFLINE_MAX_MS = 60_000;

/** The ceiling for a dial that failed with `code`. */
export function reconnectMax(code?: string): number {
  return code === "daemon_offline" ? DAEMON_OFFLINE_MAX_MS : RECONNECT_MAX_MS;
}

/** Bounded jitter prevents every suspended phone from reconnecting together. */
export function reconnectDelay(attempt: number, random = Math.random, max = RECONNECT_MAX_MS): number {
  const ceiling = Math.max(RECONNECT_BASE_MS, max);
  const steps = Math.max(0, Math.ceil(Math.log2(ceiling / RECONNECT_BASE_MS)));
  const base = Math.min(ceiling, RECONNECT_BASE_MS * 2 ** Math.min(Math.max(0, attempt), steps));
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(ceiling, Math.round(base * jitter));
}

/**
 * A page hidden this long may come back to a path that died silently. Its
 * foreground probe then starts a second relay handshake beside the old path
 * instead of waiting out the probe deadline first.
 */
export const STANDBY_AWAY_MS = 10_000;

/**
 * A read that gave up at its deadline is the first sign a path stalled: the
 * heartbeat would not notice for another 25 s. Checking costs one Ping, so a
 * run of timeouts spends at most one every floor.
 */
export const PATH_CHECK_FLOOR_MS = 10_000;

/** Whether this read timeout should verify the path now instead of waiting for the heartbeat. */
export function pathCheckDue(live: boolean, checking: boolean, lastCheckAt: number, now: number): boolean {
  if (!live || checking) return false;
  return lastCheckAt === 0 || now - lastCheckAt >= PATH_CHECK_FLOOR_MS;
}

export const HELLO_WINDOW_MS = 60_000;
/** The computer admits ten DeviceHello1 per device a minute. A standby is a
 * guess, so it only spends while the dials that must happen keep most of them. */
export const STANDBY_HELLO_LIMIT = 4;

/** DeviceHello1 sent by one logical session: dials, standbys and direct upgrades. */
export class HelloBudget {
  private spent: number[] = [];

  spend(now = Date.now()): void {
    this.spent = this.recent(now);
    this.spent.push(now);
  }

  /** Whether one more speculative handshake stays inside the standby share. */
  spare(now = Date.now()): boolean {
    return this.recent(now).length < STANDBY_HELLO_LIMIT;
  }

  private recent(now: number): number[] {
    // A clock that jumped backwards keeps what was spent: the cautious reading.
    return this.spent.filter((at) => now - at < HELLO_WINDOW_MS);
  }
}
