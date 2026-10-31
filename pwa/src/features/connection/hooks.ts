import { useSyncExternalStore } from "react";
import { useDomain } from "../../shared/react/use-domain";
import { connectionStore, type BootBlock, type Phase } from "./connection-store";
import { runtimeStore } from "./runtime-store";

/** React snapshots for the connection/runtime domains. Owned by the connection feature. */
export function useConnection() {
  return useDomain(connectionStore);
}

export function useRuntime() {
  return useDomain(runtimeStore);
}

const connectionPhase = () => connectionStore.get().phase;

/**
 * Only the lifecycle phase, for a shell that switches a class or a page on it.
 * The domain also publishes reachability, transports and relay timing; none of
 * those changes which page is on screen.
 */
export function useConnectionPhase(): Phase {
  return useSyncExternalStore(connectionStore.subscribe, connectionPhase, connectionPhase);
}

const retryingUnreachableOf = () => connectionStore.get().retryingUnreachable;

/** Whether the "cannot reach" page is retrying, for the shell that keeps it up. */
export function useRetryingUnreachable(): boolean {
  return useSyncExternalStore(connectionStore.subscribe, retryingUnreachableOf, retryingUnreachableOf);
}

const connectFailureOf = () => connectionStore.get().connectFailure;

/** Why the last connect attempt failed, for a page that explains it. */
export function useConnectFailure(): string {
  return useSyncExternalStore(connectionStore.subscribe, connectFailureOf, connectFailureOf);
}

const bootBlockedOf = () => connectionStore.get().bootBlocked;
const networkOnlineOf = () => connectionStore.get().networkOnline;

/**
 * Why boot is holding, for the shells that only draw that. The domain publishes
 * a relay trip on every heartbeat too; that does not unblock a boot.
 */
export function useBootBlocked(): BootBlock | null {
  return useSyncExternalStore(connectionStore.subscribe, bootBlockedOf, bootBlockedOf);
}

/**
 * Browser reachability, for anything that only gates network work on it. A
 * measured relay trip is not a reachability change.
 */
export function useNetworkOnline(): boolean {
  return useSyncExternalStore(connectionStore.subscribe, networkOnlineOf, networkOnlineOf);
}

const contactKey = () => {
  const record = connectionStore.get();
  return [
    record.phase, record.bootBlocked, record.networkOnline, record.sessionTransport,
    record.connectFailure, record.transportSwitching, record.networkMode, record.p2pEnabled,
  ].join("\u0000");
};

/**
 * Every connection field a header's verdict can depend on, and nothing else.
 *
 * A screen that asks "can the status on this pane still be confirmed?" has to
 * repaint the moment contact changes, whichever field says so, so it subscribes
 * to all of them. What it must not follow is the measured relay trip: a
 * heartbeat is not a change of contact, and it arrives on a timer.
 *
 * Returns the contact reading so a re-render is a changed value, not a side
 * effect; callers that only need the repaint ignore it.
 */
export function useConnectionContact(): string {
  return useSyncExternalStore(connectionStore.subscribe, contactKey, contactKey);
}
