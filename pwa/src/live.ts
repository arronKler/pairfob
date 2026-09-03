import {
  choosePane,
  herdSignature,
  type SnapshotWire as Snapshot,
} from "./lib/dashboard";
import { t } from "./lib/i18n";
import type { NetworkMode } from "./lib/network-mode";
import { credentialIsBurned, phaseAfterComputers, sortComputers } from "./lib/computer-catalog";
import { deleteCredential, loadCatalog, rememberLastUsed, saveCredential } from "./lib/credentials";
import {
  NO_OPERATION_CAPABILITIES,
  parseRuntimeOperationsConfig,
} from "./lib/operations";
import {
  ProtocolError,
  sessionOverWS,
  type FinishedP2PAttemptObservation,
  type LiveSession,
  type PairResult,
  type SessionEvent,
} from "./lib/protocol/client";
import type { ReconnectReason } from "./lib/protocol/session-types";
import { ComputerSessions, type SessionConnector } from "./computer-sessions";
import { createLivePolling } from "./live-polling";
import { resetLiveConnectionState } from "./live-state";
import { nextTouchedAt } from "./lib/ranking";
import { openPendingNotification } from "./notifications";
import { panePollDelayMs, pokeRefreshAction, shouldPullStatus } from "./poll";
import {
  bindPaneRefresh,
  type PaneReadObservation,
  type PaneRefreshRequest,
} from "./pane-refresh-request";
import { render } from "./paint";
import {
  FRIENDLY_ERROR,
  acknowledgePaneCompletion,
  clearNotice,
  loadPaneTouched,
  loadPanePinned,
  loadCompletionSeen,
  loadPaneComposeLive,
  messageOf,
  paneComposeLive,
  sessionEventNotice,
  loadPaneTermModes,
  paneTermMode,
  rememberPane,
  replaceAgentsFromSnapshot,
  resetPaneView,
  savePaneTouched,
  selectedAgent,
  showError,
  showStatus,
  state,
  wsURL,
} from "./state";
import { isDesk } from "./viewport";
import { composeField, dropQueuedKeys, paneReadLines, patchChromeTitle, patchSessionScreen, preserveCompose } from "./ui/session-view";
import { canEnterAgentChat, patchAgentChat, refreshAgentTrace, restoreAgentTrace } from "./ui/agent-chat";
import { disposeFullTerminal, handleFullTerminalEvent, leaveFullTerminal } from "./ui/full-terminal";
import { preloadFullTerminalXterm } from "./ui/full-terminal-loader";
import { resolvedPaneTermMode } from "./ui/terminal-mode";
import { guidedScrollController } from "./ui/session/guided-scroll";
import { track } from "./lib/telemetry";

const livePolling = createLivePolling({
  canRun: () => state.networkOnline && document.visibilityState === "visible" && state.phase === "live" && state.live?.isConnected() === true,
  canReadPane: () => state.screen === "pane" && Boolean(state.paneId) && !state.fullTerminal,
  paneDelayMs: () => panePollDelayMs(state.agentChat, selectedAgent()?.status === "working"),
  refreshSnapshot: () => refreshSnapshot(),
  refreshPane: async () => { await refreshPaneRead(); },
});
const computerSessions = new ComputerSessions(3);
const connectComputerSession: SessionConnector = (credential, observeP2PAttempt) =>
  sessionOverWS(wsURL({ daemonId: credential.daemonId }), credential, {
    p2p: state.p2pEnabled,
    networkMode: state.networkMode,
    onP2PAttempt: (observation) => {
      const { result, extra } = observation;
      track("pwa_p2p", { result, extra });
      observeP2PAttempt(observation);
    },
  });
let herdConfigRequest = 0;
let liveViewVersion = 0;
type PaneReadFlight = {
  session: LiveSession;
  viewVersion: number;
  paneId: string;
  startedAt: number;
  promise: Promise<PaneReadObservation | null>;
};
type QueuedPaneRead = {
  session: LiveSession;
  viewVersion: number;
  paneId: string;
  postponeFallback: boolean;
  promise: Promise<PaneReadObservation | null>;
  resolve: (observation: PaneReadObservation | null) => void;
};
let paneReadFlight: PaneReadFlight | null = null;
let queuedPaneRead: QueuedPaneRead | null = null;

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function liveViewIsCurrent(session: LiveSession, viewVersion: number): boolean {
  return state.live === session && liveViewVersion === viewVersion;
}

export async function reloadComputers(): Promise<void> {
  const catalog = await loadCatalog(location.origin);
  state.lastUsedDaemonId = catalog.lastUsedDaemonId;
  state.computers = sortComputers(catalog.credentials, catalog.lastUsedDaemonId);
}

function resetPaneReadRequests(): void {
  paneReadFlight = null;
  queuedPaneRead?.resolve(null);
  queuedPaneRead = null;
  state.paneReadBusy = false;
  state.paneReadPending = false;
}

function invalidateLiveView(): void {
  liveViewVersion++;
  herdConfigRequest++;
  state.refreshBusy = false;
  state.snapshotPending = false;
  resetPaneReadRequests();
}

export function clearLiveConnection(): void {
  const session = state.live;
  const daemonId = state.credential?.daemonId;
  stopPolling();
  dropQueuedKeys();
  guidedScrollController.dispose();
  disposeFullTerminal();
  invalidateLiveView();
  if (session && (!daemonId || !computerSessions.remove(daemonId, session))) session.close();
  resetLiveConnectionState();
}

export function closeComputerSession(daemonId: string): void {
  if (state.credential?.daemonId === daemonId && state.live) {
    clearLiveConnection();
    return;
  }
  computerSessions.remove(daemonId);
}

export function setLiveNetworkAvailable(available: boolean): void {
  computerSessions.setNetworkAvailable(available);
  const active = state.live;
  const daemonId = state.credential?.daemonId;
  if (active && (!daemonId || !computerSessions.has(daemonId, active))) active.setNetworkAvailable(available);
}

export function reconnectLiveSessions(reason: ReconnectReason = "probe"): void {
  computerSessions.reconnectNow(reason);
  const active = state.live;
  const daemonId = state.credential?.daemonId;
  if (active && (!daemonId || !computerSessions.has(daemonId, active))) active.reconnectNow(reason);
}

export function syncInactiveTransportMode(mode: NetworkMode, active?: LiveSession): void {
  computerSessions.syncTransportMode(mode, active);
}

export async function landAfterDisconnect(opts: {
  daemonId?: string | null;
  code?: string;
  error?: unknown;
  silent?: boolean;
}): Promise<void> {
  const code = opts.code || (opts.error instanceof ProtocolError ? opts.error.code : "");
  clearLiveConnection();
  if (opts.daemonId && credentialIsBurned(code)) {
    await deleteCredential(opts.daemonId).catch(() => undefined);
    if (state.credential?.daemonId === opts.daemonId) state.credential = null;
  }
  await reloadComputers().catch(() => undefined);
  state.addingComputer = false;
  state.screen = "home";
  state.phase = phaseAfterComputers(state.computers.length);
  if (!state.computers.length) state.credential = null;
  if (!opts.silent) {
    const burned = credentialIsBurned(code) && (code === "revoked" || code === "unpaired");
    if (opts.error) showError(burned ? FRIENDLY_ERROR.revoked : messageOf(opts.error), true);
    else if (code) showError(burned ? FRIENDLY_ERROR.revoked : sessionEventNotice({ type: "terminal", code }), true);
  }
  track("pwa_disconnect", { result: code || "disconnected" });
  render();
}

export async function establish(pair: PairResult, connect: SessionConnector = connectComputerSession): Promise<void> {
  stopPolling();
  dropQueuedKeys();
  guidedScrollController.dispose();
  state.phase = "resuming";
  state.credential = pair;
  state.addingComputer = false;
  render();
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  else disposeFullTerminal();
  invalidateLiveView();
  resetLiveConnectionState();
  state.phase = "resuming";
  state.credential = pair;
  state.addingComputer = false;
  state.herdHost = pair.hostname || "";
  state.snapshotAt = 0;
  state.paneTouched = loadPaneTouched();
  state.panePinned = loadPanePinned();
  state.paneTermModes = loadPaneTermModes();
  state.paneComposeLive = loadPaneComposeLive();
  await rememberLastUsed(pair.daemonId).catch(() => undefined);
  state.lastUsedDaemonId = pair.daemonId;
  const activated = await computerSessions.activate(pair, connect);
  const session = activated.session;
  state.live = session;
  state.relayRttMs = activated.lastLatencyMs;
  state.sessionTransport = activated.transport;
  state.lastP2PAttempt = activated.lastP2PAttempt;
  if (!activated.reused && !computerSessions.bind(pair.daemonId, session, onSessionEvent, onP2PAttempt)) {
    computerSessions.remove(pair.daemonId, session);
    throw new ProtocolError("disconnected", t("err.computerConnect"));
  }
  if (!computerSessions.has(pair.daemonId, session)) {
    throw new ProtocolError("disconnected", t("err.computerConnect"));
  }
  const seen = { ...pair, lastSeen: Math.floor(Date.now() / 1000) };
  state.credential = seen;
  await saveCredential(seen).catch(() => undefined);
  session.setNetworkAvailable(state.networkOnline);
  if (activated.reused) void session.switchTransport(state.networkMode).catch(() => undefined);
  state.completionSeen = loadCompletionSeen();
  state.phase = "live";
  state.screen = "home";
  track("pwa_live");
  if (document.visibilityState === "hidden") showStatus(t("live.hidden"));
  else clearNotice();
  render();
  startPolling();
  await refreshRuntimeState();
  await reloadComputers().catch(() => undefined);
}

function onP2PAttempt(
  daemonId: string,
  session: LiveSession,
  attempt: FinishedP2PAttemptObservation,
): void {
  if (state.live !== session || state.credential?.daemonId !== daemonId) return;
  state.lastP2PAttempt = attempt;
  if (state.screen === "settings") render();
}

function onSessionEvent(daemonId: string, session: LiveSession, event: SessionEvent): void {
  if (!computerSessions.has(daemonId, session)) return;
  if (state.live !== session || state.credential?.daemonId !== daemonId) {
    if (event.type === "terminal") void handleInactiveTerminal(daemonId, session, event.code);
    return;
  }
  if (guidedScrollController.handleEvent(event)) return;
  if (handleFullTerminalEvent(event) && (event.type === "terminal_frame" || event.type === "terminal_closed")) return;
  if (event.type === "latency" && typeof event.rttMs === "number") {
    const previousTransport = state.sessionTransport;
    state.relayRttMs = Math.max(0, Math.round(event.rttMs));
    state.sessionTransport = event.transport ?? state.sessionTransport;
    if (state.sessionTransport === "p2p" && previousTransport !== "p2p") preloadFullTerminalXterm();
    if (state.screen === "settings") render();
    return;
  }
  if (event.type === "poke" && document.visibilityState === "visible") {
    const action = pokeRefreshAction(state.screen, state.paneId, event.paneId, event.reason);
    if (action === "runtime") void refreshRuntimeState();
    else if (action === "snapshot") void refreshSnapshot();
    else if (action === "paneread") {
      livePolling.wakePane();
      if (state.agentChat && shouldPullStatus(true, Date.now(), state.snapshotAt)) void refreshSnapshot();
    }
    return;
  }
  if (event.type === "connected") {
    clearNotice();
    startPolling();
    render();
    if (document.visibilityState === "visible") void refreshRuntimeState();
  } else if (event.type === "disconnected" || event.type === "reconnecting") {
    state.relayRttMs = null;
    state.sessionTransport = "relay";
    stopPolling();
    showStatus(sessionEventNotice(event), true);
    render();
  } else if (event.type === "terminal") {
    void handleTerminal(event);
  }
}

async function handleInactiveTerminal(daemonId: string, session: LiveSession, code = ""): Promise<void> {
  if (!computerSessions.remove(daemonId, session)) return;
  if (credentialIsBurned(code)) await deleteCredential(daemonId).catch(() => undefined);
  await reloadComputers().catch(() => undefined);
  if (state.screen === "computers") render();
  track("pwa_disconnect", { result: code || "disconnected", extra: "inactive" });
}

export async function refreshRuntimeState(): Promise<void> {
  const session = state.live;
  const updated = await refreshHerdConfig();
  if (!updated || state.live !== session) return;
  if (state.runtimeKind === "herdr" && state.notice?.text === FRIENDLY_ERROR.herdr_offline) clearNotice();
  render();
  await refreshFromSession();
}

async function handleTerminal(event: SessionEvent): Promise<void> {
  await landAfterDisconnect({ daemonId: state.credential?.daemonId, code: event.code });
}

export async function refreshHerdConfig(): Promise<boolean> {
  const session = state.live;
  const request = ++herdConfigRequest;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  state.agentKinds = [];
  if (!session) return false;
  try {
    const config = await session.getConfig();
    const operations = parseRuntimeOperationsConfig(config);
    if (request !== herdConfigRequest || state.live !== session) return false;
    const hostname = typeof config.hostname === "string" ? config.hostname : "";
    state.herdHost = hostname;
    state.runtimeKind = typeof config.runtime === "string" ? config.runtime : "";
    state.pushEnabled = config.push_enabled === true;
    state.operationCapabilities = operations.capabilities;
    state.agentKinds = operations.agentKinds;
    if (state.credential && hostname && state.credential.hostname !== hostname) {
      const updated = { ...state.credential, hostname, lastSeen: Math.floor(Date.now() / 1000) };
      state.credential = updated;
      await saveCredential(updated).catch(() => undefined);
      await reloadComputers().catch(() => undefined);
    }
    return true;
  } catch {
    if (request === herdConfigRequest && state.live === session) {
      state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
      state.agentKinds = [];
      // A failed GetConfig is unverifiable, not Herdr-exited: drop the stale
      // kind so the verdict does not keep claiming a last-known runtime.
      state.runtimeKind = "";
      return true;
    }
    return false;
  }
}

export async function openPane(paneId: string): Promise<void> {
  dropQueuedKeys();
  guidedScrollController.dispose();
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  rememberPane(paneId);
  state.paneId = paneId;
  resetPaneView();
  state.composeLive = paneComposeLive(paneId);
  restoreAgentTrace(paneId);
  clearNotice();
  state.screen = "pane";
  const mode = resolvedPaneTermMode(paneTermMode(paneId));
  const agent = state.agents.find((item) => item.paneId === paneId);
  state.fullTerminal = mode === "full";
  state.agentChat = mode === "agent" && canEnterAgentChat(agent);
  acknowledgePaneCompletion(paneId);
  render();
  await refreshPane();
}

function abandonOpenPane(message: string): void {
  disposeFullTerminal();
  state.screen = "home";
  resetPaneView();
  showError(message, true);
  render();
}

export async function refreshSnapshot(): Promise<void> {
  const session = state.live;
  const viewVersion = liveViewVersion;
  if (!session || !session.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return;
  if (state.refreshBusy) {
    state.snapshotPending = true;
    return;
  }
  state.refreshBusy = true;
  try {
    const snapshot = (await session.snapshot()) as Snapshot;
    if (!liveViewIsCurrent(session, viewVersion)) return;
    state.snapshotAt = Date.now();
    const previous = replaceAgentsFromSnapshot(snapshot);
    state.paneTouched = nextTouchedAt(previous, state.agents, state.paneTouched);
    savePaneTouched();
    const nextSig = herdSignature(state.agents);
    const unchanged = nextSig === state.lastHerdSig;
    state.lastHerdSig = nextSig;
    if (await openPendingNotification(openPane)) return;
    if (state.screen === "pane") {
      state.paneId = choosePane(state.paneId, state.agents);
      if (!state.paneId) {
        abandonOpenPane(t("err.paneGone"));
        return;
      }
      if (state.agentChat) {
        if (!patchAgentChat()) render();
        return;
      }
      if (unchanged) {
        patchChromeTitle();
        if (isDesk()) render();
        return;
      }
      patchChromeTitle();
      if (isDesk()) render();
      return;
    }
    if (state.screen === "workspace" && state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
      state.screen = "home";
      state.paneId = "";
      state.paneText = "";
      state.paneHash = "";
      showError(t("err.paneGone"), true);
      render();
      return;
    }
    if (state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
      state.paneId = "";
      state.paneText = "";
      state.paneHash = "";
    }
    if ((state.screen === "home" || state.screen === "workspace" || state.screen === "settings" || state.screen === "computers") && unchanged) return;
    render();
  } catch (error) {
    if (!liveViewIsCurrent(session, viewVersion)) return;
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) showError(messageOf(error));
    render();
  } finally {
    if (liveViewIsCurrent(session, viewVersion)) {
      state.refreshBusy = false;
      if (state.snapshotPending) {
        state.snapshotPending = false;
        void refreshSnapshot();
      }
    }
  }
}

async function performPaneRead(
  session: LiveSession,
  viewVersion: number,
  paneId: string,
  startedAt: number,
): Promise<PaneReadObservation | null> {
  if (
    !liveViewIsCurrent(session, viewVersion) ||
    state.paneId !== paneId ||
    !session.isConnected() ||
    !state.networkOnline ||
    document.visibilityState === "hidden"
  ) return null;
  if (state.screen !== "pane" || state.fullTerminal || state.agentChat) return null;
  try {
    const read = await session.paneRead(paneId, paneReadLines());
    if (
      !liveViewIsCurrent(session, viewVersion) ||
      state.paneId !== paneId ||
      state.screen !== "pane" ||
      state.fullTerminal
    ) return null;
    const nextText = typeof read?.text === "string" ? read.text : "";
    const nextHash = typeof read?.hash === "string" ? read.hash : "";
    const same = nextHash !== "" && nextHash === state.paneHash && nextText === state.paneText;
    state.paneText = nextText;
    state.paneHash = nextHash;
    const acknowledged = acknowledgePaneCompletion(paneId);
    if (shouldPullStatus(!same, Date.now(), state.snapshotAt)) void refreshSnapshot();
    const keep = preserveCompose();
    if (same) {
      patchChromeTitle();
      // An idle screen owes the desk rail one repaint only when this read
      // acknowledged a completion. Rendering every poll would remount the
      // pane and wipe an in-progress text selection over nothing.
      if (acknowledged && isDesk() && !keep) render();
      return { paneId, text: nextText, hash: nextHash, changed: false, startedAt, completedAt: monotonicNow() };
    }
    const observation = () => ({ paneId, text: nextText, hash: nextHash, changed: true, startedAt, completedAt: monotonicNow() });
    if (keep && patchSessionScreen()) return observation();
    if (keep && composeField()) return observation();
    if (!patchSessionScreen()) render();
    return observation();
  } catch (error) {
    if (!liveViewIsCurrent(session, viewVersion)) return null;
    const code = error instanceof ProtocolError ? error.code : "";
    if (code === "pane_not_found") {
      state.paneText = "";
      state.paneHash = "";
      await refreshSnapshot();
      if (state.screen === "pane" && state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
        abandonOpenPane(t("err.paneGone"));
      }
      return null;
    }
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) {
      showError(messageOf(error));
      render();
    }
    return null;
  }
}

function startPaneRead(session: LiveSession, viewVersion: number, paneId: string): Promise<PaneReadObservation | null> {
  const startedAt = monotonicNow();
  state.paneReadBusy = true;
  const promise = performPaneRead(session, viewVersion, paneId, startedAt);
  const flight = { session, viewVersion, paneId, startedAt, promise };
  paneReadFlight = flight;
  void promise.then(() => finishPaneRead(flight), () => finishPaneRead(flight));
  return promise;
}

function finishPaneRead(flight: PaneReadFlight): void {
  if (paneReadFlight !== flight) return;
  paneReadFlight = null;
  state.paneReadBusy = false;
  const queued = queuedPaneRead;
  queuedPaneRead = null;
  state.paneReadPending = false;
  if (!queued) return;
  const next = startPaneRead(queued.session, queued.viewVersion, queued.paneId);
  void next.then(
    (observation) => {
      if (queued.postponeFallback && observation) livePolling.deferPane();
      queued.resolve(observation);
    },
    () => queued.resolve(null),
  );
}

function queuePaneRead(
  session: LiveSession,
  viewVersion: number,
  paneId: string,
  request: PaneRefreshRequest,
): Promise<PaneReadObservation | null> {
  const queued = queuedPaneRead;
  const queuedForAnotherView = queued && (
    queued.session !== session ||
    queued.viewVersion !== viewVersion ||
    queued.paneId !== paneId
  );
  if (queuedForAnotherView) {
    queued.resolve(null);
    queuedPaneRead = null;
  }
  if (queuedPaneRead) {
    queuedPaneRead.postponeFallback ||= request.postponeFallback === true;
    return queuedPaneRead.promise;
  }
  let resolve!: (observation: PaneReadObservation | null) => void;
  const promise = new Promise<PaneReadObservation | null>((done) => { resolve = done; });
  queuedPaneRead = {
    session,
    viewVersion,
    paneId,
    postponeFallback: request.postponeFallback === true,
    promise,
    resolve,
  };
  state.paneReadPending = true;
  return promise;
}

function postponeFallback(promise: Promise<PaneReadObservation | null>, enabled: boolean): Promise<PaneReadObservation | null> {
  if (!enabled) return promise;
  return promise.then((observation) => {
    if (observation) livePolling.deferPane();
    return observation;
  });
}

export async function refreshPaneRead(request: PaneRefreshRequest = {}): Promise<PaneReadObservation | null> {
  const session = state.live;
  const viewVersion = liveViewVersion;
  if (!session || !state.paneId || !session.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return null;
  if (state.screen !== "pane" || state.fullTerminal) return null;
  if (state.agentChat) {
    const changed = await refreshAgentTrace();
    if (changed && shouldPullStatus(true, Date.now(), state.snapshotAt)) void refreshSnapshot();
    return null;
  }
  const paneId = state.paneId;
  const notBefore = request.notBefore ?? 0;
  if (paneReadFlight) {
    const reusableFlight = paneReadFlight.session === session &&
      paneReadFlight.viewVersion === viewVersion &&
      paneReadFlight.paneId === paneId &&
      paneReadFlight.startedAt >= notBefore;
    if (reusableFlight) {
      return postponeFallback(paneReadFlight.promise, request.postponeFallback === true);
    }
    return queuePaneRead(session, viewVersion, paneId, request);
  }
  return postponeFallback(startPaneRead(session, viewVersion, paneId), request.postponeFallback === true);
}

export async function refreshFromSession(): Promise<void> {
  await Promise.all([
    refreshSnapshot(),
    state.screen === "pane" && state.paneId && !state.fullTerminal ? refreshPaneRead() : Promise.resolve(),
  ]);
}

export async function refreshPane(): Promise<void> {
  if (!state.live || !state.paneId || !state.live.isConnected()) {
    state.paneText = "";
    state.paneHash = "";
    render();
    return;
  }
  await refreshPaneRead();
}

export function startPolling(): void {
  livePolling.start();
}

export function stopPolling(): void {
  livePolling.stop();
}

bindPaneRefresh(refreshPaneRead);
