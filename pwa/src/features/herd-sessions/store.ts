import { immutableCopy, type Immutable } from "../../shared/model/domain-store";
import type { HerdSessionSummary, LiveSession } from "../../lib/protocol/session-types";

/**
 * Herdr-session list store.
 *
 * "Herdr session" is one of the independent sessions a single daemon can
 * address (`herdr --session <name>`), not the paired phone-daemon connection
 * that `features/session/` owns.
 *
 * One list per live connection, the same ownership the quota store uses: a
 * pooled computer keeps its own list, and a reply that lands after a computer
 * switch writes the retired connection's entry, which no mounted view reads.
 * The *selected* session is not stored here at all; the connection owns it
 * (`LiveSession.herdSession()`), so the UI cannot drift from what RPCs target.
 *
 * Each read takes a per-connection token, so an older ListSessions answer can
 * never overwrite a newer one on the same connection.
 */
export type HerdSessionList = Immutable<{ sessions: HerdSessionSummary[] }>;

const lists = new WeakMap<LiveSession, HerdSessionList>();
const latestRead = new WeakMap<LiveSession, number>();
const listeners = new Set<() => void>();
let readSerial = 0;

/** The list last read on this connection, or undefined when it has none (old or opted-out daemon). */
export function herdSessionList(session: LiveSession | null | undefined): HerdSessionList | undefined {
  return session ? lists.get(session) : undefined;
}

/** Start a read on this connection; only the newest token may publish. */
export function beginHerdSessionRead(session: LiveSession): number {
  readSerial += 1;
  latestRead.set(session, readSerial);
  return readSerial;
}

export function herdSessionReadIsCurrent(session: LiveSession, token: number): boolean {
  return latestRead.get(session) === token;
}

/** Adopt a list (or `null` to hide the switcher) for one connection and notify. */
export function setHerdSessionList(session: LiveSession, sessions: readonly HerdSessionSummary[] | null): void {
  if (sessions) lists.set(session, immutableCopy({ sessions: [...sessions] }));
  else lists.delete(session);
  for (const listener of [...listeners]) listener();
}

/** Tell subscribers the selection moved; the value itself lives on the connection. */
export function notifyHerdSessionSelection(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeHerdSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
