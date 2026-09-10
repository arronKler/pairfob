import { networkOnline } from "./connection-store";
import { liveSession } from "../computers/catalog-store";
import { runtimeIdentity } from "./runtime-store";
import type { RuntimeLiveness } from "../../lib/runtime-liveness";
import { canInterruptAgentWith, herdLivenessOf, herdStatusOf, type HerdStatus, type HerdStatusInput } from "./herd-status";

/**
 * Connection runtime status adapter — the feature's one connected module.
 *
 * These are action-time reads, not React snapshots: a caller asks "what is the
 * herd status right now" while building a header or deciding whether an interrupt
 * may be offered. So they go through the domains' live-record read helpers
 * (`liveSession`, `networkOnline`, `runtimeIdentity`), which is what an owner
 * action reads, rather than `store.get()`, which is the last published snapshot
 * and would answer with a value the caller has already moved past.
 *
 * `herd-status.ts` stays pure, so a session or dashboard consumer that already
 * holds those four values can project a status itself instead of calling this.
 *
 * `runtimeIdentity()` allocates a fresh frozen pair on each call; it is only
 * read here at action time, never used as a React getSnapshot.
 */

/** The runtime-status inputs for the session the application is currently on. */
export function currentHerdStatusInput(): HerdStatusInput {
  const identity = runtimeIdentity();
  return {
    connected: liveSession()?.isConnected() === true,
    checking: liveSession()?.isChecking?.() === true,
    networkOnline: networkOnline(),
    runtimeKind: identity.runtimeKind,
    herdHost: identity.herdHost,
  };
}

export function herdLiveness(): RuntimeLiveness {
  return herdLivenessOf(currentHerdStatusInput());
}

export function herdStatus(): HerdStatus {
  return herdStatusOf(currentHerdStatusInput());
}

export function canInterruptAgent(status: string): boolean {
  return canInterruptAgentWith(status, herdLiveness());
}
