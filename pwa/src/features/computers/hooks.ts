import { useSyncExternalStore } from "react";
import type { LiveSession, PairResult } from "../../lib/protocol/client";
import { computersStore, credential, liveSession } from "./catalog-store";
import { useConnectionPhase } from "../connection/hooks";
import { useDomain } from "../../shared/react/use-domain";

/** React snapshot for the paired-computer catalog domain. Owned by the computers feature. */
export function useComputers() {
  return useDomain(computersStore);
}

const liveSessionOf = () => computersStore.get().live;

/**
 * The live session handle, followed by the screen that draws it.
 *
 * The handle is opaque and keeps its identity across a transport drop, while
 * `isConnected()` answers from the socket; so a reader that gates an action on
 * that answer also follows the connection domain, which is what moves when the
 * answer does.
 */
export function useLiveSession(): LiveSession | null {
  useConnectionPhase();
  return useSyncExternalStore(computersStore.subscribe, liveSessionOf, liveSessionOf);
}

const credentialKey = () => {
  const pair = computersStore.get().credential;
  return pair ? `${pair.daemonId}\u0000${pair.hostname ?? ""}\u0000${pair.label}` : "";
};

/**
 * The computer this phone is paired with, for a frame that draws only that.
 * The domain also publishes the catalog and the seen stamps; the boot frame is
 * mounted before either exists, so it must not follow them.
 */
export function useCredential(): PairResult | null {
  const key = useSyncExternalStore(computersStore.subscribe, credentialKey, credentialKey);
  return key ? credential() : null;
}
