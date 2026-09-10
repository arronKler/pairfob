import { parsePairingFragment, type FragmentPairing } from "../../lib/pairing-input";
import { clientWsURL, type OriginConfig } from "../../lib/origin-config";
import { NETWORK_MODE_KEY, parseNetworkMode, persistNetworkMode, type NetworkMode } from "../../lib/network-mode";
import { parseNotificationTarget, type NotificationTarget } from "../../lib/notification-target";
import type { MuxProtocol } from "../../lib/protocol/mux";
import type { FinishedP2PAttemptObservation } from "../../lib/protocol/client";
import { batch, createDomain, detach, immutableCopy } from "../../shared/model/domain-store";
import { composeTransaction } from "../../shared/model/compose-transaction";
import type { DomainEnvironment } from "../../shared/model/domain-environment";
import { setPairCodeDraft } from "../pairing/form-store";

/**
 * App/connection domain: where the application is in its lifecycle and which
 * network path it may use. Owns boot phase, reachability, origin protocol and
 * the transport preference/observation. It never owns pairing input, computers
 * or session data.
 */
export type Phase = "boot" | "connect" | "pairing" | "resuming" | "live" | "pick";

export type ConnectionRecord = {
  phase: Phase;
  originProtocol: MuxProtocol;
  p2pEnabled: boolean;
  /** Pairing intent captured from the URL fragment before boot decided a screen. */
  fragment: FragmentPairing | null;
  /** Notification deep link target; mutually exclusive with `fragment`. */
  notificationTarget: NotificationTarget | null;
  /** Browser-reported reachability. `true` is a hint; `false` gates network work. */
  networkOnline: boolean;
  /** Latest phone-to-Pairfob WebSocket heartbeat round trip. */
  relayRttMs: number | null;
  /** Active encrypted session path; P2P is attempted without blocking relay use. */
  sessionTransport: "relay" | "p2p";
  /** Settings preference for Auto / P2P / Relay. The live path is `sessionTransport`. */
  networkMode: NetworkMode;
  /** Last finished P2P attempt for the settings path card. Cancelled attempts are ignored. */
  lastP2PAttempt: FinishedP2PAttemptObservation | null;
  /** A user-requested transport change is negotiating or reconnecting. */
  transportSwitching: boolean;
};

/**
 * Pure defaults: importing this module needs no `navigator` and no storage. The
 * browser boot lifecycle hydrates reachability and the stored transport
 * preference through `hydrateConnection` before the first mount.
 */
export function initialConnection(): ConnectionRecord {
  return {
    phase: "boot",
    originProtocol: 2,
    p2pEnabled: false,
    fragment: null,
    notificationTarget: null,
    networkOnline: true,
    relayRttMs: null,
    sessionTransport: "relay",
    networkMode: "auto",
    lastP2PAttempt: null,
    transportSwitching: false,
  };
}

const connectionDomain = createDomain<ConnectionRecord>("connection", initialConnection());
export const connectionStore = connectionDomain.store;
const { read, write, stage } = connectionDomain.controller;

/**
 * Notification intent generation. Every freshly captured deep-link target
 * advances it; consumption captures it once, before clearing the target. A
 * newer link arriving *during* that consumption — even for the same computer
 * and session, e.g. a replacement pane captured by a subscriber — retires the
 * old continuation: matching only session/daemon cannot tell the two apart.
 * Clearing a consumed target does not mint an intent.
 */
let notificationIntentSeq = 0;

/** The current notification intent generation; read at action time. */
export function notificationGeneration(): number {
  return notificationIntentSeq;
}


/** Adopt the browser facts boot resolved: reachability and the stored mode. */
export function hydrateConnection(environment: DomainEnvironment): void {
  write((record) => {
    record.networkOnline = environment.online;
    record.networkMode = parseNetworkMode(environment.read(NETWORK_MODE_KEY));
  });
}

/** Boot phase. `boot`/`resuming` render the boot screen; `live` unlocks data. */
export function setPhase(phase: Phase): void {
  if (read().phase === phase) return;
  // The page for a boot/connect/pick phase differs, so this is a composition
  // change: it publishes together with the composition it selects.
  composeTransaction([connectionStore], () => {
    stage((record) => {
      record.phase = phase;
    });
  });
}

export function phase(): Phase {
  return read().phase;
}

/** Adopt the origin configuration resolved during boot. */
export function applyOriginConfig(config: Pick<OriginConfig, "protocol" | "p2p">): void {
  write((record) => {
    record.originProtocol = config.protocol;
    record.p2pEnabled = config.p2p;
  });
}

/** Browser reachability changed. `false` gates network work; `true` is a hint. */
export function setNetworkOnline(online: boolean): boolean {
  const changed = read().networkOnline !== online;
  write((record) => {
    record.networkOnline = online;
  });
  return changed;
}

export function networkOnline(): boolean {
  return read().networkOnline;
}

/** Current transport preference, read at action time. */
export function networkMode(): NetworkMode {
  return read().networkMode;
}

/** Whether the origin offers the P2P path, read at action time. */
export function p2pEnabled(): boolean {
  return read().p2pEnabled;
}

/** The origin protocol the relay spoke during boot, read at action time. */
export function originProtocol(): MuxProtocol {
  return read().originProtocol;
}

/**
 * The pairing fragment the URL captured, or null once consumed.
 *
 * Action-time read: each call re-reads the live canonical record and returns a
 * detached frozen copy, so a caller can never write through it into the next
 * pairing intent — not on a plain read, and not inside a staged batch where
 * `store.get()` is still the stale published snapshot.
 */
export function pairingFragment(): FragmentPairing | null {
  const fragment = read().fragment;
  return fragment ? immutableCopy(fragment) : null;
}

/**
 * Adopt a fragment a scanner resolved. The adopted plain data is detached, so
 * the scanner keeping its result object cannot mutate the captured intent.
 */
export function applyPairingFragment(fragment: FragmentPairing): void {
  write((record) => {
    record.fragment = detach(fragment);
  });
}

/**
 * The notification deep link, or null once consumed. Like `pairingFragment`,
 * a detached frozen plain view read at action time: a caller can never redirect
 * the next pane intent by mutating the returned target.
 */
export function notificationTarget(): NotificationTarget | null {
  const target = read().notificationTarget;
  return target ? immutableCopy(target) : null;
}

/** The encrypted session path in use; P2P is attempted without blocking relay. */
export function sessionTransport(): "relay" | "p2p" {
  return read().sessionTransport;
}

export function setSessionTransport(transport: "relay" | "p2p"): void {
  if (read().sessionTransport === transport) return;
  write((record) => {
    record.sessionTransport = transport;
  });
}

export function setTransportSwitching(switching: boolean): void {
  if (read().transportSwitching === switching) return;
  write((record) => {
    record.transportSwitching = switching;
  });
}

export function noteRelayRtt(ms: number | null): void {
  write((record) => {
    record.relayRttMs = ms;
  });
}

export function noteP2PAttempt(attempt: FinishedP2PAttemptObservation | null): void {
  write((record) => {
    record.lastP2PAttempt = attempt ? detach(attempt) : null;
  });
}

export function setNetworkMode(mode: NetworkMode): void {
  if (read().networkMode === mode) return;
  // Persist inside the write's batch: a subscriber must not run between the
  // record change and its storage.
  batch(() => {
    write((record) => {
      record.networkMode = mode;
    });
    persistNetworkMode(mode);
  });
}

/**
 * Read the URL fragment once, before boot chooses a screen. A notification deep
 * link wins over a pairing fragment; the hash is scrubbed either way so a reload
 * does not replay an intent.
 */
export function capturePairingFragment(): void {
  const initialHash = location.hash;
  if (initialHash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  const notificationTarget = parseNotificationTarget(initialHash);
  const fragment = notificationTarget ? null : parsePairingFragment(initialHash);
  batch(() => {
    write((record) => {
      record.notificationTarget = notificationTarget ? detach(notificationTarget) : null;
      record.fragment = fragment ? detach(fragment) : null;
    });
    // A captured deep link is a new intent. Advanced inside the batch so every
    // subscriber fires after the generation and target settle together.
    if (notificationTarget) notificationIntentSeq += 1;
    // The pairing domain owns its own draft field.
    setPairCodeDraft(fragment?.code || "");
  });
}

/** The notification deep link is not paired with a known computer any more. */
export function clearNotificationTarget(): void {
  if (!read().notificationTarget) return;
  write((record) => {
    record.notificationTarget = null;
  });
}

/** Drop a consumed pairing intent (boot already acted on it). */
export function clearPairingFragment(): void {
  if (!read().fragment) return;
  write((record) => {
    record.fragment = null;
  });
}

export function wsURL(query?: { daemonId?: string; pairTicket?: string }): string {
  return clientWsURL(read().originProtocol, location, query);
}
