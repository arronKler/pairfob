import {
  choosePane,
  herdSignature,
  type SnapshotWire as Snapshot,
} from "./lib/dashboard";
import { t } from "./lib/i18n";
import { credentialIsBurned, phaseAfterComputers, sortComputers } from "./lib/computer-catalog";
import { deleteCredential, loadCatalog, rememberLastUsed, saveCredential } from "./lib/credentials";
import {
  NO_OPERATION_CAPABILITIES,
  parseRuntimeOperationsConfig,
} from "./lib/operations";
import { ProtocolError, sessionOverWS, type PairResult, type SessionEvent } from "./lib/protocol/client";
import { createLivePolling } from "./live-polling";
import { resetLiveConnectionState } from "./live-state";
import { nextTouchedAt } from "./lib/ranking";
import { openPendingNotification } from "./notifications";
import { panePollDelayMs, pokeRefreshAction, shouldPullStatus } from "./poll";
import { clearAgentTraceCache } from "./lib/agent-trace-cache";
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
import { guidedScrollController } from "./ui/session/guided-scroll";
import { track } from "./lib/telemetry";

const livePolling = createLivePolling({
  canRun: () => state.networkOnline && document.visibilityState === "visible" && state.phase === "live" && state.live?.isConnected() === true,
  canReadPane: () => state.screen === "pane" && Boolean(state.paneId) && !state.fullTerminal,
  paneDelayMs: () => panePollDelayMs(state.agentChat, selectedAgent()?.status === "working"),
  refreshSnapshot: () => refreshSnapshot(),
  refreshPane: async () => { await refreshPaneRead(); },
});
let herdConfigRequest = 0;
type PaneReadFlight = {
  paneId: string;
  startedAt: number;
  promise: Promise<PaneReadObservation | null>;
};
type QueuedPaneRead = {
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

export async function reloadComputers(): Promise<void> {
  const catalog = await loadCatalog(location.origin);
  state.lastUsedDaemonId = catalog.lastUsedDaemonId;
  state.computers = sortComputers(catalog.credentials, catalog.lastUsedDaemonId);
}

export function clearLiveConnection(): void {
  stopPolling();
  guidedScrollController.dispose();
  disposeFullTerminal();
  state.live?.close();
  resetLiveConnectionState();
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
    if (opts.error) showError(burned ? FRIENDLY_ERROR.revoked : messageOf(opts.error));
    else if (code) showError(burned ? FRIENDLY_ERROR.revoked : sessionEventNotice({ type: "terminal", code }));
  }
  track("pwa_disconnect", { result: code || "disconnected" });
  render();
}

export async function establish(pair: PairResult): Promise<void> {
  stopPolling();
  clearAgentTraceCache();
  disposeFullTerminal();
  state.phase = "resuming";
  state.credential = pair;
  state.addingComputer = false;
  state.agents = [];
  state.runtimeAgentStatuses = {};
  state.completionSeen = {};
  state.paneId = "";
  state.herdHost = pair.hostname || "";
  state.runtimeKind = "";
  state.deviceList = [];
  state.pushSubscribed = null;
  state.lastHerdSig = "";
  state.snapshotAt = 0;
  resetPaneView();
  render();
  state.live?.close();
  if (state.live) state.live = null;
  state.relayRttMs = null;
  state.paneTouched = loadPaneTouched();
  state.paneTermModes = loadPaneTermModes();
  state.paneComposeLive = loadPaneComposeLive();
  await rememberLastUsed(pair.daemonId).catch(() => undefined);
  state.lastUsedDaemonId = pair.daemonId;
  state.live = await sessionOverWS(wsURL({ daemonId: pair.daemonId }), pair);
  const seen = { ...pair, lastSeen: Math.floor(Date.now() / 1000) };
  state.credential = seen;
  await saveCredential(seen).catch(() => undefined);
  state.live.onEvent(onSessionEvent);
  state.live.setNetworkAvailable(state.networkOnline);
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

function onSessionEvent(event: SessionEvent): void {
  if (guidedScrollController.handleEvent(event)) return;
  if (handleFullTerminalEvent(event) && (event.type === "terminal_frame" || event.type === "terminal_closed")) return;
  if (event.type === "latency" && typeof event.rttMs === "number") {
    state.relayRttMs = Math.max(0, Math.round(event.rttMs));
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
    stopPolling();
    showStatus(sessionEventNotice(event), true);
    render();
  } else if (event.type === "terminal") {
    void handleTerminal(event);
  }
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
  const mode = paneTermMode(paneId);
  const agent = state.agents.find((item) => item.paneId === paneId);
  state.fullTerminal = mode === "full";
  state.agentChat = mode === "agent" && canEnterAgentChat(agent);
  render();
  preloadFullTerminalXterm();
  await refreshPane();
}

function abandonOpenPane(message: string): void {
  disposeFullTerminal();
  state.screen = "home";
  resetPaneView();
  showError(message);
  render();
}

export async function refreshSnapshot(): Promise<void> {
  if (!state.live || !state.live.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return;
  if (state.refreshBusy) {
    state.snapshotPending = true;
    return;
  }
  state.refreshBusy = true;
  try {
    const snapshot = (await state.live.snapshot()) as Snapshot;
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
    if (state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
      state.paneId = "";
      state.paneText = "";
      state.paneHash = "";
    }
    if ((state.screen === "home" || state.screen === "settings" || state.screen === "computers") && unchanged) return;
    render();
  } catch (error) {
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) showError(messageOf(error));
    render();
  } finally {
    state.refreshBusy = false;
    if (state.snapshotPending) {
      state.snapshotPending = false;
      void refreshSnapshot();
    }
  }
}

async function performPaneRead(paneId: string, startedAt: number): Promise<PaneReadObservation | null> {
  const session = state.live;
  if (!session || state.paneId !== paneId || !session.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return null;
  if (state.screen !== "pane" || state.fullTerminal || state.agentChat) return null;
  try {
    const read = await session.paneRead(paneId, paneReadLines());
    if (state.live !== session || state.paneId !== paneId || state.screen !== "pane" || state.fullTerminal) return null;
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

function startPaneRead(paneId: string): Promise<PaneReadObservation | null> {
  const startedAt = monotonicNow();
  state.paneReadBusy = true;
  const promise = performPaneRead(paneId, startedAt);
  const flight = { paneId, startedAt, promise };
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
  const next = startPaneRead(queued.paneId);
  void next.then(
    (observation) => {
      if (queued.postponeFallback && observation) livePolling.deferPane();
      queued.resolve(observation);
    },
    () => queued.resolve(null),
  );
}

function queuePaneRead(paneId: string, request: PaneRefreshRequest): Promise<PaneReadObservation | null> {
  if (queuedPaneRead && queuedPaneRead.paneId !== paneId) {
    queuedPaneRead.resolve(null);
    queuedPaneRead = null;
  }
  if (queuedPaneRead) {
    queuedPaneRead.postponeFallback ||= request.postponeFallback === true;
    return queuedPaneRead.promise;
  }
  let resolve!: (observation: PaneReadObservation | null) => void;
  const promise = new Promise<PaneReadObservation | null>((done) => { resolve = done; });
  queuedPaneRead = {
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
  if (!state.live || !state.paneId || !state.live.isConnected() || !state.networkOnline || document.visibilityState === "hidden") return null;
  if (state.screen !== "pane" || state.fullTerminal) return null;
  if (state.agentChat) {
    const changed = await refreshAgentTrace();
    if (changed && shouldPullStatus(true, Date.now(), state.snapshotAt)) void refreshSnapshot();
    return null;
  }
  const paneId = state.paneId;
  const notBefore = request.notBefore ?? 0;
  if (paneReadFlight) {
    if (paneReadFlight.paneId === paneId && paneReadFlight.startedAt >= notBefore) {
      return postponeFallback(paneReadFlight.promise, request.postponeFallback === true);
    }
    return queuePaneRead(paneId, request);
  }
  return postponeFallback(startPaneRead(paneId), request.postponeFallback === true);
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
