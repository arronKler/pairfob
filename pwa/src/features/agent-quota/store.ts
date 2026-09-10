import { immutableCopy, type Immutable } from "../../shared/model/domain-store";
import type { QuotaRead } from "../../lib/agent-quota";
import type { LiveSession } from "../../lib/protocol/session-types";

/**
 * Quota snapshot store.
 *
 * One snapshot per live session, replaced wholesale on every update so a reader
 * can compare identity and a subscriber can be told something changed. Keying by
 * session is what makes a late reply harmless: after a computer switch the answer
 * lands on the retired session's entry and the mounted view, which reads the
 * current session, never sees it.
 *
 * Ownership is the point of the two types below. The store *adopts* what a caller
 * hands it — a deep copy, so the caller keeps its own object and later edits to
 * that object cannot change published data — and it *publishes* a deep-frozen
 * value typed read-only, so no reader holds a write path into the snapshot. That
 * is what keeps the in-flight guard authoritative: a consumer cannot clear
 * `loading` and start a second request whose older answer then overwrites a newer
 * one, and a reentrant subscriber sees the same frozen `loading` the controller
 * wrote. The caller's own graph is never frozen, because the store copies it
 * instead of taking it over.
 */

/**
 * Caller-owned input. Plain data the store adopts by copying. `items` is
 * read-only because the common caller either forwards a fresh protocol answer or
 * carries the previous published snapshot into a loading state, and neither
 * should have to hand over a writable array.
 */
export type QuotaSnapshotInput = { loading: boolean; items: readonly QuotaRead[] | null; error: string };

/** Published snapshot: deep read-only, and frozen at runtime to match. */
export type QuotaSnapshot = Immutable<QuotaSnapshotInput>;

const snapshots = new WeakMap<LiveSession, QuotaSnapshot>();
const listeners = new Set<() => void>();

export function quotaSnapshot(session: LiveSession | null | undefined): QuotaSnapshot | undefined {
  return session ? snapshots.get(session) : undefined;
}

/** Adopt one session's snapshot and tell subscribers. Never mutates in place. */
export function setQuotaSnapshot(session: LiveSession, next: QuotaSnapshotInput): void {
  snapshots.set(session, immutableCopy(next));
  // Iterate a copy: a subscriber that re-enters the store must not disturb this
  // notification round.
  for (const listener of [...listeners]) listener();
}

export function subscribeQuota(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Historical read/write seam, kept because QA scenes and the quota tests set a
 * fixture snapshot directly. Same shape as the WeakMap it replaces, except that a
 * write adopts its input and notifies subscribers instead of waiting for a global
 * repaint.
 */
export const views = {
  get: quotaSnapshot,
  set: (session: LiveSession, next: QuotaSnapshotInput): void => setQuotaSnapshot(session, next),
};
