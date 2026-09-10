/**
 * Connection lifecycle: establish, retire, land, pool network.
 *
 * Destination identity is captured before any await. After rememberLastUsed,
 * activate, saveCredential and catalog reloads the attempt is rechecked so a
 * newer establish or a disconnect cannot publish into the new owner. Domain
 * writes that belong together go through `batch` so a subscriber never sees a
 * live handle wearing the previous computer's capabilities.
 */
import { reloadCompletionSeen } from "../dashboard/catalog-store";
import { applyRuntimeIdentity } from "./runtime-store";
import { adoptDaemonPreferences } from "../settings/preferences-store";
import {
  attachLiveSession,
  computersStore,
  currentDaemonId,
  liveSession,
  setAddingComputer,
  setComputers,
  setCredential,
  setLastUsedDaemon,
} from "../computers/catalog-store";
import {
  connectionStore,
  networkOnline,
  noteP2PAttempt,
  noteRelayRtt,
  setSessionTransport,
  setPhase,
} from "./connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { batch } from "../../shared/model/domain-store";
import {
  ComputerSessions,
  SupersededActivationError,
  type ActivatedSession,
  type P2PAttemptListener,
  type SessionConnector,
  type SessionListener,
} from "../computers/session-pool";
import { credentialIsBurned, phaseAfterComputers, sortComputers } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { FRIENDLY_ERROR, messageOf, sessionEventNotice } from "../../lib/notices";
import type { NetworkMode } from "../../lib/network-mode";
import { ProtocolError, type PairResult } from "../../lib/protocol/client";
import type { LiveSession, ReconnectReason } from "../../lib/protocol/session-types";
import {
  bumpLiveView,
  cancelEstablish,
  catalogRequestIsCurrent,
  establishAttemptIsCurrent,
  liveView,
  nextCatalogRequest,
  nextEstablishAttempt,
} from "./generations";
import type { LifecyclePorts } from "./ports";
import { retireLiveDomains, type RetirementPorts } from "./retirement";

export type LifecycleContext = {
  pool: ComputerSessions;
  defaultConnect: SessionConnector;
  onSessionEvent: SessionListener;
  onP2PAttempt: P2PAttemptListener;
  ports: LifecyclePorts;
  retirement: RetirementPorts;
};

function parkSession(ports: LifecyclePorts): void {
  ports.stopPolling();
  ports.dropQueuedKeys();
  ports.disposeGuidedScroll();
}

function stillThisAttempt(attempt: number): boolean {
  return establishAttemptIsCurrent(attempt);
}

function invalidateReads(ports: LifecyclePorts): void {
  bumpLiveView();
  ports.resetPaneReads();
  ports.setRefreshIdle();
}

export type ReloadCatalogOptions = {
  /** An establish that lost to a newer one drops its catalog completion. */
  attempt?: number;
  /**
   * Caller-owned acceptance (Core boot-generation contract): captured before
   * the read, tested after the awaited catalog read and before any canonical
   * write. Returning false drops the stale completion without a rollback.
   */
  shouldApply?: () => boolean;
};

/**
 * Load the daemon catalog into the computers domain.
 *
 * Overlapping reloads never race: the request generation is captured before
 * the read and checked before any write, so a stale catalog completion cannot
 * overwrite the latest one.
 */
export async function reloadComputers(
  ports: LifecyclePorts,
  options: ReloadCatalogOptions = {},
): Promise<void> {
  const request = nextCatalogRequest();
  const catalog = await ports.loadCatalog(ports.origin());
  if (!catalogRequestIsCurrent(request)) return;
  if (options.attempt !== undefined && !stillThisAttempt(options.attempt)) return;
  if (options.shouldApply && !options.shouldApply()) return;
  batch(() => {
    setLastUsedDaemon(catalog.lastUsedDaemonId);
    setComputers(sortComputers(catalog.credentials, catalog.lastUsedDaemonId));
  });
}

/**
 * Retire the current live session. If `expected` is supplied and a newer
 * session already replaced it, only the old pool entry is closed — the new
 * owner's domains stay.
 */
export function clearLiveConnection(ctx: LifecycleContext, expected: LiveSession | null = liveSession()): void {
  const daemonId = currentDaemonId();
  ctx.ports.captureComposeDraft();
  if (expected && liveSession() && liveSession() !== expected) {
    if (daemonId) ctx.pool.remove(daemonId, expected);
    else expected.close();
    return;
  }
  parkSession(ctx.ports);
  ctx.ports.disposeFullTerminal();
  cancelEstablish();
  invalidateReads(ctx.ports);
  if (expected && (!daemonId || !ctx.pool.remove(daemonId, expected))) expected.close();
  ctx.retirement.bumpViewIncarnation();
  ctx.retirement.clearAgentTraceCache();
  ctx.retirement.clearBoardPreviews();
  batch(() => retireLiveDomains());
}

export function closeComputerSession(daemonId: string, ctx: LifecycleContext): void {
  if (currentDaemonId() === daemonId && liveSession()) {
    clearLiveConnection(ctx);
    return;
  }
  ctx.pool.remove(daemonId);
}

export function setLiveNetworkAvailable(available: boolean, ctx: LifecycleContext): void {
  ctx.pool.setNetworkAvailable(available);
  const active = liveSession();
  const daemonId = currentDaemonId();
  if (active && (!daemonId || !ctx.pool.has(daemonId, active))) active.setNetworkAvailable(available);
}

export function reconnectLiveSessions(reason: ReconnectReason, ctx: LifecycleContext): void {
  ctx.pool.reconnectNow(reason);
  const active = liveSession();
  const daemonId = currentDaemonId();
  if (active && (!daemonId || !ctx.pool.has(daemonId, active))) active.reconnectNow(reason);
}

export function syncInactiveTransportMode(
  mode: NetworkMode,
  ctx: LifecycleContext,
  active?: LiveSession,
): void {
  ctx.pool.syncTransportMode(mode, active);
}

export async function landAfterDisconnect(
  ctx: LifecycleContext,
  opts: { daemonId?: string | null; code?: string; error?: unknown; silent?: boolean },
): Promise<void> {
  const session = liveSession();
  const code = opts.code || (opts.error instanceof ProtocolError ? opts.error.code : "");
  clearLiveConnection(ctx, session);
  const landView = liveView();
  if (opts.daemonId && credentialIsBurned(code)) {
    await ctx.ports.deleteCredential(opts.daemonId).catch(() => undefined);
    if (liveView() !== landView) return;
    if (currentDaemonId() === opts.daemonId) setCredential(null);
  }
  await reloadComputers(ctx.ports).catch(() => undefined);
  if (liveView() !== landView || liveSession() !== null) return;
  const count = computersStore.get().computers.length;
  batch(() => {
    setAddingComputer(false);
    setScreen("home");
    setPhase(phaseAfterComputers(count));
    if (!count) setCredential(null);
  });
  if (!opts.silent) {
    const burned = credentialIsBurned(code) && (code === "revoked" || code === "unpaired");
    if (opts.error) ctx.ports.showError(burned ? FRIENDLY_ERROR.revoked : messageOf(opts.error), true);
    else if (code) {
      ctx.ports.showError(burned ? FRIENDLY_ERROR.revoked : sessionEventNotice({ type: "terminal", code }), true);
    }
  }
  ctx.ports.track("pwa_disconnect", { result: code || "disconnected" });
  ctx.ports.commitView();
}

export async function establish(
  pair: PairResult,
  connect: SessionConnector | undefined,
  ctx: LifecycleContext,
): Promise<void> {
  const attempt = nextEstablishAttempt();
  // Plain destination identity captured once. A caller mutating `pair` while
  // any await below is pending cannot retarget this attempt to another daemon.
  const destination: PairResult = {
    deviceId: pair.deviceId,
    psk: pair.psk,
    daemonPk: pair.daemonPk,
    daemonId: pair.daemonId,
    fp: pair.fp,
    relayOrigin: pair.relayOrigin,
    label: pair.label,
    createdAt: pair.createdAt,
    hostname: pair.hostname,
    lastSeen: pair.lastSeen,
  };
  ctx.ports.captureComposeDraft();
  if (ctx.ports.isFullTerminal()) await ctx.ports.leaveFullTerminal();
  else ctx.ports.disposeFullTerminal();
  if (!stillThisAttempt(attempt)) return;
  parkSession(ctx.ports);
  invalidateReads(ctx.ports);
  ctx.retirement.bumpViewIncarnation();
  ctx.retirement.clearAgentTraceCache();
  ctx.retirement.clearBoardPreviews();
  batch(() => {
    retireLiveDomains();
    setPhase("resuming");
    setCredential(destination);
    setAddingComputer(false);
    applyRuntimeIdentity({ herdHost: destination.hostname || "", runtimeKind: "" });
    adoptDaemonPreferences();
  });
  ctx.ports.commitView();
  if (!stillThisAttempt(attempt)) return;
  await ctx.ports.rememberLastUsed(destination.daemonId).catch(() => undefined);
  if (!stillThisAttempt(attempt)) return;
  setLastUsedDaemon(destination.daemonId);
  let activated: ActivatedSession;
  try {
    activated = await ctx.pool.activate(destination, connect ?? ctx.defaultConnect);
  } catch (error) {
    // A newer activation owns the daemon slot, or this attempt lost while the
    // connector ran. Either way the attempt is stale: retire quietly so an
    // obsolete transport failure cannot surface as the new owner's error.
    if (error instanceof SupersededActivationError || !stillThisAttempt(attempt)) return;
    throw error;
  }
  const session = activated.session;
  // Complete the retained entry's listener lifetime before checking the
  // attempt: a superseded activation that inserted its session must not leave
  // a listener-less entry that a later reuse would adopt silently.
  const bound = ctx.pool.bind(destination.daemonId, session, ctx.onSessionEvent, ctx.onP2PAttempt);
  if (!stillThisAttempt(attempt)) return;
  batch(() => {
    attachLiveSession(session);
    noteRelayRtt(activated.lastLatencyMs);
    setSessionTransport(activated.transport);
    noteP2PAttempt(activated.lastP2PAttempt);
  });
  if (!stillThisAttempt(attempt)) return;
  if (!bound && !ctx.pool.has(destination.daemonId, session)) {
    // The entry is gone (evicted or replaced) while this attempt is current.
    throw new ProtocolError("disconnected", t("err.computerConnect"));
  }
  const seen = { ...destination, lastSeen: Math.floor(Date.now() / 1000) };
  setCredential(seen);
  await ctx.ports.saveCredential(seen).catch(() => undefined);
  if (!stillThisAttempt(attempt)) return;
  session.setNetworkAvailable(networkOnline());
  if (activated.reused) void session.switchTransport(connectionStore.get().networkMode).catch(() => undefined);
  reloadCompletionSeen();
  batch(() => {
    setPhase("live");
    setScreen("home");
  });
  ctx.ports.track("pwa_live");
  if (!ctx.ports.documentVisible()) ctx.ports.showStatus(t("live.hidden"));
  else ctx.ports.clearNotice();
  ctx.ports.commitView();
  if (!stillThisAttempt(attempt)) return;
  ctx.ports.startPolling();
  await ctx.ports.refreshRuntime();
  if (!stillThisAttempt(attempt)) return;
  await reloadComputers(ctx.ports, { attempt }).catch(() => undefined);
}

export async function handleInactiveTerminal(
  ctx: LifecycleContext,
  daemonId: string,
  session: LiveSession,
  code = "",
): Promise<void> {
  if (!ctx.pool.remove(daemonId, session)) return;
  if (credentialIsBurned(code)) await ctx.ports.deleteCredential(daemonId).catch(() => undefined);
  await reloadComputers(ctx.ports).catch(() => undefined);
  if (currentScreen() === "computers") ctx.ports.commitView();
  ctx.ports.track("pwa_disconnect", { result: code || "disconnected", extra: "inactive" });
}
