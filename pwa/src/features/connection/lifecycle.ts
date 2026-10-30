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
import { beginIdentityRead } from "./runtime";
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
  setConnectFailure,
  setRetryingUnreachable,
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
import { credentialIsBurned, phaseAfterComputers } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { FRIENDLY_ERROR, messageOf, sessionEventNotice } from "../../lib/notices";
import type { NetworkMode } from "../../lib/network-mode";
import { ProtocolError, type PairResult } from "../../lib/protocol/client";
import type { LiveSession, ReconnectReason } from "../../lib/protocol/session-types";
import {
  bumpLiveView,
  cancelEstablish,
  establishAttemptIsCurrent,
  herdSwitchIsCurrent,
  liveView,
  nextEstablishAttempt,
  nextHerdSwitch,
} from "./generations";
import type { LifecyclePorts } from "./ports";
import { retireHerdView, retireLiveDomains, type RetirementPorts } from "./retirement";
import { adoptRetainedView, forgetRetainedView, retainLiveView, retainedViewFor } from "./retained-view";
import { pauseAttachmentTransfers } from "../session/attachments/attachments-store";
import { markAppPerformance } from "../../lib/performance-marks";
import { reloadComputers } from "./catalog-load";
export { reloadComputers, type ReloadCatalogOptions } from "./catalog-load";

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
  if (expected) {
    if (!daemonId) expected.close();
    else if (ctx.pool.remove(daemonId, expected)) forgetRetainedView(daemonId);
    else expected.close();
  }
  ctx.retirement.bumpViewIncarnation();
  ctx.retirement.clearAgentTraceCache();
  ctx.retirement.clearBoardPreviews();
  batch(() => retireLiveDomains());
}

/**
 * Retarget the live connection at another Herdr session on the same daemon.
 *
 * No re-pairing: the connection and its transport stay. Everything else is the
 * same complete transition a computer switch makes: in-flight reads lose their
 * view generation before the selection moves, the old session's panes, board,
 * capabilities and pane-scoped caches retire in one batch, and the target's
 * config (capabilities, agent kinds) is read again before its snapshot. Returns
 * false when a newer switch, establish or disconnect took over.
 */
export async function switchHerdSession(name: string | null, ctx: LifecycleContext): Promise<boolean> {
  const session = liveSession();
  if (!session?.selectHerdSession || !session.herdSession || session.herdSession() === name) return false;
  const serial = nextHerdSwitch();
  const viewVersion = liveView();
  const owned = () => herdSwitchIsCurrent(serial) && liveSession() === session && liveView() === viewVersion;
  ctx.ports.captureComposeDraft();
  if (ctx.ports.isFullTerminal()) await ctx.ports.leaveFullTerminal();
  else ctx.ports.disposeFullTerminal();
  if (!owned()) return false;
  parkSession(ctx.ports);
  invalidateReads(ctx.ports);
  ctx.retirement.bumpViewIncarnation();
  ctx.retirement.clearAgentTraceCache();
  ctx.retirement.clearBoardPreviews();
  const daemonId = currentDaemonId();
  if (daemonId) forgetRetainedView(daemonId);
  pauseAttachmentTransfers(daemonId, session.herdSession());
  session.selectHerdSession(name);
  const screen = currentScreen();
  batch(() => {
    retireHerdView();
    // Pane-scoped preferences are keyed by Herdr session; load the target's.
    adoptDaemonPreferences();
    reloadCompletionSeen();
    beginIdentityRead();
    // A pane or its files belong to the old session; settings and the board stay.
    if (screen === "pane" || screen === "workspace") setScreen("home");
  });
  ctx.ports.track("pwa_switch_herd_session");
  ctx.ports.commitView();
  if (liveSession() !== session) return false;
  ctx.ports.startPolling();
  await ctx.ports.refreshRuntime();
  return liveSession() === session;
}

export function closeComputerSession(daemonId: string, ctx: LifecycleContext): void {
  if (currentDaemonId() === daemonId && liveSession()) {
    clearLiveConnection(ctx);
    return;
  }
  if (ctx.pool.remove(daemonId)) forgetRetainedView(daemonId);
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
    // The single-computer failure page explains network failures in place.
    setConnectFailure(code || "disconnected");
    setRetryingUnreachable(false);
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
  markAppPerformance("session-establish-start");
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
  retainLiveView();
  parkSession(ctx.ports);
  invalidateReads(ctx.ports);
  ctx.retirement.bumpViewIncarnation();
  ctx.retirement.clearAgentTraceCache();
  ctx.retirement.clearBoardPreviews();
  ctx.retirement.clearHerdAttention();
  const pooled = ctx.pool.reuse(destination);
  const retained = pooled
    ? retainedViewFor(destination, pooled.session.herdSession?.() ?? null)
    : null;
  if (retained && pooled) {
    ctx.pool.bind(destination.daemonId, pooled.session, ctx.onSessionEvent, ctx.onP2PAttempt);
    // The tap's own turn: the kept rows paint before any await. No identity
    // write of "", no "resuming" phase and no identity read — the kept view
    // carries the identity, and the config read below only starts one when it
    // is empty.
    batch(() => {
      retireLiveDomains();
      setCredential(destination);
      setAddingComputer(false);
      attachLiveSession(pooled.session);
      noteRelayRtt(pooled.lastLatencyMs);
      setSessionTransport(pooled.transport);
      noteP2PAttempt(pooled.lastP2PAttempt);
      adoptDaemonPreferences();
      reloadCompletionSeen();
      adoptRetainedView(retained);
      setConnectFailure("");
      setRetryingUnreachable(false);
      setPhase("live");
      setScreen("home");
    });
    ctx.ports.commitView();
    ctx.ports.track("pwa_switch_retained", { result: "pooled" });
  } else {
    batch(() => {
      retireLiveDomains();
      setPhase("resuming");
      setCredential(destination);
      setAddingComputer(false);
      applyRuntimeIdentity({ herdHost: destination.hostname || "", runtimeKind: "" });
      adoptDaemonPreferences();
    });
    ctx.ports.commitView();
  }
  if (!stillThisAttempt(attempt)) return;
  await ctx.ports.rememberLastUsed(destination.daemonId).catch(() => undefined);
  if (!stillThisAttempt(attempt)) return;
  setLastUsedDaemon(destination.daemonId);
  let activated: ActivatedSession;
  try {
    activated = retained && pooled ? pooled : await ctx.pool.activate(destination, connect ?? ctx.defaultConnect);
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
  // The retained path already attached this session in its own batch.
  if (!retained) {
    batch(() => {
      attachLiveSession(session);
      noteRelayRtt(activated.lastLatencyMs);
      setSessionTransport(activated.transport);
      noteP2PAttempt(activated.lastP2PAttempt);
    });
  }
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
  // The retained path already loaded it under the destination credential.
  if (!retained) reloadCompletionSeen();
  batch(() => {
    // The list's first paint must read "reading", not "cannot confirm Herdr":
    // the runtime identity is fetched right after this.
    if (!retained) beginIdentityRead();
    setConnectFailure("");
    setRetryingUnreachable(false);
    setPhase("live");
    setScreen("home");
  });
  ctx.ports.track("pwa_live");
  markAppPerformance("session-established");
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
  forgetRetainedView(daemonId);
  if (credentialIsBurned(code)) await ctx.ports.deleteCredential(daemonId).catch(() => undefined);
  await reloadComputers(ctx.ports).catch(() => undefined);
  if (currentScreen() === "computers") ctx.ports.commitView();
  ctx.ports.track("pwa_disconnect", { result: code || "disconnected", extra: "inactive" });
}
