/**
 * The paired computer's clock as seen from the phone. Trace record times come
 * from that clock, so a running turn's elapsed time is measured against it, not
 * against the phone's (which may be off by seconds or minutes).
 */
let offsetMs = 0;

/** Record the computer's `now` from a timed AgentTraceSummary reply. */
export function noteDaemonClock(daemonNow: number, phoneNow = Date.now()): void {
  offsetMs = daemonNow - phoneNow;
}

export function daemonNow(phoneNow = Date.now()): number {
  return phoneNow + offsetMs;
}
