import { acceptDaemonVersion, markDaemonConfigIncompatible } from "../settings/daemon-update";
import { t } from "../../lib/i18n";
import type { NetworkMode } from "../../lib/network-mode";
import { deleteCredential, loadCatalog, rememberLastUsed, saveCredential } from "../../lib/credentials";
import {
  ProtocolError,
  sessionOverWS,
  type LiveSession,
  type PairResult,
  type SessionEvent,
} from "../../lib/protocol/client";
import type { ReconnectReason } from "../../lib/protocol/session-types";
import { ComputerSessions, type SessionConnector } from "../computers/session-pool";
import { dashboardStore, selectedAgent, setRefreshBusy } from "../dashboard/catalog-store";
import { computersStore, currentDaemonId, liveSession } from "../computers/catalog-store";
import { currentScreen } from "../../app/navigation-store";
import { connectionStore, networkOnline } from "./connection-store";
import {
  applyPaneRead,
  isAgentChat,
  isFullTerminal,
  lastSnapshotAt,
  openPaneId,
  sessionStore,
  setPaneReadBusy,
  setPaneReadPending,
} from "../session/session-store";

import { createLivePolling } from "./polling";
import { openPendingNotification } from "../settings/notifications";
import { panePollDelayMs, shouldPullStatus } from "./poll-schedule";
import {
  bindPaneRefresh,
  type PaneReadObservation,
  type PaneRefresh,
  type PaneRefreshRequest,
} from "./refresh-request";
import { createPaneReadLane, type PaneReadOwner } from "./pane-read";
import { refreshHerdConfig as observeHerdConfig, refreshRuntimeState as observeRuntimeState } from "./runtime";
import { commitView } from "../../app/host";
import { acknowledgePaneCompletion } from "../dashboard/catalog-store";
import { clearNotice, showError, showStatus } from "../../app/notices-store";
import { leavePaneScreen } from "../../app/navigation-store";
import { messageOf, sessionEventNotice } from "../../lib/notices";
import { resetPaneView } from "../session/session-store";
import { wsURL } from "./connection-store";
import { track } from "../../lib/telemetry";
import { applyComposeDraft, bumpViewIncarnation, captureComposeDraft, currentViewIncarnation, parkComposeView } from "../session/drafts/compose-drafts";
import { clearAgentTraceCache } from "../../lib/agent-trace-cache";
import { clearBoardPreviews } from "../board/preview/store";
import { liveView, liveViewIsCurrent } from "./generations";
import { openPaneWithOwner as openOwnedPane, type PaneNavigation } from "./open-pane";
import { observeP2PAttempt, observeSessionEvent } from "./session-events";
import { refreshSnapshot as observeSnapshot } from "./snapshot";
import type { LifecyclePorts } from "./ports";
import {
  type LifecycleContext,
  clearLiveConnection as retireLiveConnection,
  closeComputerSession as retireComputerSession,
  establish as establishConnection,
  handleInactiveTerminal as retireInactiveTerminal,
  landAfterDisconnect as landConnection,
  reconnectLiveSessions as reconnectPool,
  reloadComputers as reloadComputerCatalog,
  setLiveNetworkAvailable as setPoolNetwork,
  syncInactiveTransportMode as syncPoolTransport,
} from "./lifecycle";
import type { RetirementPorts } from "./retirement";
import { isDesk } from "../../app/viewport";
import { refreshBoardPreviews } from "../../features/board/preview/refresh";
import { composeField, preserveCompose } from "../../features/session/guided/compose";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { paneReadLines } from "../../features/session/guided/pane-model";
import { patchChromeTitle, patchSessionScreen } from "../../features/session/guided/view";
import { canEnterAgentChat, patchAgentChat, refreshAgentTrace, restoreAgentTrace } from "../../features/session/chat/agent-chat-controller";
import { disposeFullTerminal, handleFullTerminalEvent, leaveFullTerminal, leaveFullTerminalWithTransition, syncFullTerminalChrome } from "../session/full-terminal/full-terminal";
import { preloadFullTerminalXterm } from "../session/full-terminal/full-terminal-loader";
import { resolvedPaneTermMode } from "../session/term-mode";
import { guidedScrollController } from "../session/guided/guided-scroll";
import { nextTransition, queuedKind, transitionFor } from "../../app/transition";

const livePolling = createLivePolling({
  canRun: () => networkOnline() && document.visibilityState === "visible" && connectionStore.get().phase === "live" && liveSession()?.isConnected() === true,
  canReadPane: () =>
    (currentScreen() === "pane" && Boolean(openPaneId()) && !isFullTerminal()) ||
    currentScreen() === "board",
  paneDelayMs: () => panePollDelayMs(isAgentChat(), selectedAgent()?.status === "working"),
  refreshSnapshot: () => refreshSnapshot(),
  refreshPane: async () => {
    if (currentScreen() === "board") await refreshBoardPreviews();
    else await refreshPaneRead();
  },
});
const computerSessions = new ComputerSessions(3);
const connectComputerSession: SessionConnector = (credential, observeP2PAttempt) =>
  sessionOverWS(wsURL({ daemonId: credential.daemonId }), credential, {
    p2p: connectionStore.get().p2pEnabled,
    networkMode: connectionStore.get().networkMode,
    onP2PAttempt: (observation) => {
      const { result, extra } = observation;
      track("pwa_p2p", { result, extra });
      // Forward the finished observation into the pool's connector channel: it
      // records attempts that land before bind (adopted later as the entry's
      // lastP2PAttempt) and routes later ones to the bound lifecycle listener.
      observeP2PAttempt(observation);
    },
  });
function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function viewIsCurrent(session: LiveSession, viewVersion: number): boolean {
  return liveViewIsCurrent(session, viewVersion, liveSession());
}

let paneReads: ReturnType<typeof createPaneReadLane>;

function resetPaneReadRequests(): void {
  paneReads.reset();
}

const retirementPorts: RetirementPorts = {
  bumpViewIncarnation,
  clearAgentTraceCache,
  clearBoardPreviews,
};

const lifecyclePorts: LifecyclePorts = {
  captureComposeDraft,
  dropQueuedKeys,
  disposeGuidedScroll: () => guidedScrollController.dispose(),
  disposeFullTerminal,
  leaveFullTerminal: () => leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => undefined),
  isFullTerminal,
  commitView,
  documentVisible: () => document.visibilityState === "visible",
  showError,
  showStatus,
  clearNotice,
  loadCatalog,
  rememberLastUsed,
  saveCredential,
  deleteCredential,
  startPolling: () => livePolling.start(),
  stopPolling: () => livePolling.stop(),
  refreshRuntime: () => refreshRuntimeState(),
  resetPaneReads: resetPaneReadRequests,
  setRefreshIdle: () => setRefreshBusy(false),
  track,
  origin: () => location.origin,
};

const lifecycle: LifecycleContext = {
  pool: computerSessions,
  defaultConnect: connectComputerSession,
  onSessionEvent: (daemonId, session, event) => onSessionEvent(daemonId, session, event),
  onP2PAttempt: (daemonId, session, attempt) => onP2PAttempt(daemonId, session, attempt),
  ports: lifecyclePorts,
  retirement: retirementPorts,
};

export async function reloadComputers(shouldApply?: () => boolean): Promise<void> {
  await reloadComputerCatalog(lifecyclePorts, { shouldApply });
}

export function clearLiveConnection(): void {
  retireLiveConnection(lifecycle);
}

export function closeComputerSession(daemonId: string): void {
  retireComputerSession(daemonId, lifecycle);
}

export function setLiveNetworkAvailable(available: boolean): void {
  setPoolNetwork(available, lifecycle);
}

export function reconnectLiveSessions(reason: ReconnectReason = "probe"): void {
  reconnectPool(reason, lifecycle);
}

export function syncInactiveTransportMode(mode: NetworkMode, active?: LiveSession): void {
  syncPoolTransport(mode, lifecycle, active);
}

export async function landAfterDisconnect(opts: {
  daemonId?: string | null;
  code?: string;
  error?: unknown;
  silent?: boolean;
}): Promise<void> {
  await landConnection(lifecycle, opts);
}

export async function establish(pair: PairResult, connect: SessionConnector = connectComputerSession): Promise<void> {
  await establishConnection(pair, connect, lifecycle);
}

const sessionEventPorts = {
  documentVisible: () => document.visibilityState === "visible",
  commitView,
  clearNotice,
  showStatus,
  startPolling: () => startPolling(),
  stopPolling: () => stopPolling(),
  refreshRuntime: () => refreshRuntimeState(),
  refreshSnapshot: () => refreshSnapshot(),
  wakePane: () => livePolling.wakePane(),
  preloadFullTerminal: preloadFullTerminalXterm,
  handleGuidedEvent: (event: SessionEvent) => guidedScrollController.handleEvent(event),
  handleFullTerminalEvent,
  handleInactiveTerminal: (daemonId: string, session: LiveSession, code?: string) =>
    retireInactiveTerminal(lifecycle, daemonId, session, code),
  handleActiveTerminal: (event: SessionEvent) => handleTerminal(event),
  sessionEventNotice,
};

function onP2PAttempt(
  daemonId: string,
  session: LiveSession,
  attempt: Parameters<typeof observeP2PAttempt>[2],
): void {
  observeP2PAttempt(daemonId, session, attempt, sessionEventPorts);
}

function onSessionEvent(daemonId: string, session: LiveSession, event: SessionEvent): void {
  observeSessionEvent(computerSessions, daemonId, session, event, sessionEventPorts);
}

const runtimePorts = {
  acceptDaemonVersion,
  markDaemonConfigIncompatible,
  saveCredential,
  reloadComputers,
  refreshFromSession: () => refreshFromSession(),
  commitView,
  currentLive: liveSession,
  currentCredential: () => computersStore.get().credential,
};

export async function refreshRuntimeState(): Promise<void> {
  await observeRuntimeState(runtimePorts);
}

async function handleTerminal(event: SessionEvent): Promise<void> {
  await landAfterDisconnect({ daemonId: currentDaemonId(), code: event.code });
}

export async function refreshHerdConfig(): Promise<boolean> {
  return observeHerdConfig(runtimePorts);
}

export type { PaneNavigation };

export async function openPane(paneId: string): Promise<void> {
  await openPaneWithOwner(paneId);
}

/** A completed navigation owns further UI only until another route/session/view wins. */
export async function openPaneWithOwner(paneId: string): Promise<PaneNavigation | null> {
  return openOwnedPane(paneId, {
    currentLive: liveSession,
    currentIncarnation: currentViewIncarnation,
    parkComposeView,
    dropQueuedKeys,
    disposeGuidedScroll: () => guidedScrollController.dispose(),
    leaveFullTerminal: () => leaveFullTerminalWithTransition({ rememberGuided: false, paint: false }),
    restoreAgentTrace,
    canEnterAgentChat,
    resolvedTermMode: resolvedPaneTermMode,
    queuedKind,
    nextTransition: (kind, id) => nextTransition(kind as "fade" | "push" | "pop" | "expand", id),
    transitionFor: (from, to) => transitionFor(from as "home" | "pane" | "workspace" | "settings" | "quota" | "computers" | "board", to as "pane"),
    currentScreen,
    isFullTerminal,
    findAgent: (id) => dashboardStore.get().agents.find((item) => item.paneId === id),
    commitView,
    refreshPane,
  });
}

function abandonOpenPane(message: string): void {
  parkComposeView();
  disposeFullTerminal();
  leavePaneScreen();
  resetPaneView();
  applyComposeDraft();
  showError(message, true);
  commitView();
}

const snapshotPorts = {
  currentLive: () => liveSession(),
  networkOnline,
  documentVisible: () => document.visibilityState === "visible",
  isDesk,
  openPendingNotification,
  openPane,
  abandonOpenPane,
  syncFullTerminalChrome,
  patchAgentChat,
  patchChromeTitle,
  showError,
  messageOf,
  commitView,
  now: Date.now,
};

export async function refreshSnapshot(): Promise<void> {
  await observeSnapshot(snapshotPorts);
}

function paneReadOwner(session: LiveSession, viewVersion: number, paneId: string): PaneReadOwner {
  return {
    session,
    viewVersion,
    paneId,
    incarnation: currentViewIncarnation(),
    mode: isFullTerminal() ? "full" : isAgentChat() ? "agent" : "guided",
  };
}

function paneReadOwnerIsCurrent(owner: PaneReadOwner): boolean {
  return viewIsCurrent(owner.session, owner.viewVersion) &&
    openPaneId() === owner.paneId &&
    currentViewIncarnation() === owner.incarnation &&
    (isFullTerminal() ? "full" : isAgentChat() ? "agent" : "guided") === owner.mode;
}

async function performPaneRead(owner: PaneReadOwner, startedAt: number): Promise<PaneReadObservation | null> {
  const { session, paneId } = owner;
  if (
    !paneReadOwnerIsCurrent(owner) ||
    !session.isConnected() ||
    !networkOnline() ||
    document.visibilityState === "hidden"
  ) return null;
  if (currentScreen() !== "pane" || owner.mode !== "guided") return null;
  try {
    const read = await session.paneRead(paneId, paneReadLines());
    if (!paneReadOwnerIsCurrent(owner) || currentScreen() !== "pane") return null;
    const nextText = typeof read?.text === "string" ? read.text : "";
    const nextHash = typeof read?.hash === "string" ? read.hash : "";
    const same = nextHash !== "" && nextHash === sessionStore.get().paneHash && nextText === sessionStore.get().paneText;
    applyPaneRead(nextText, nextHash);
    const acknowledged = acknowledgePaneCompletion(paneId);
    if (shouldPullStatus(!same, Date.now(), lastSnapshotAt())) void refreshSnapshot();
    const keep = preserveCompose();
    if (same) {
      patchChromeTitle();
      // An idle screen owes the desk rail one repaint only when this read
      // acknowledged a completion. Rendering every poll would remount the
      // pane and wipe an in-progress text selection over nothing.
      if (acknowledged && isDesk() && !keep) commitView();
      return { paneId, text: nextText, hash: nextHash, changed: false, startedAt, completedAt: monotonicNow() };
    }
    const observation = () => ({ paneId, text: nextText, hash: nextHash, changed: true, startedAt, completedAt: monotonicNow() });
    // Patch in place when the committed frame matches and no staged composition
    // holds: "patched" -> rendered now, "deferred" -> a held composition already
    // queued the App commit (arriving render owns it; never force a fallback
    // commit here), "missing" -> no matching terminal, fall through to commitView.
    const outcome = patchSessionScreen();
    if (keep && outcome === "patched") return observation();
    if (outcome === "deferred") return observation();
    if (keep && composeField()) return observation();
    if (outcome === "missing") commitView();
    return observation();
  } catch (error) {
    if (!paneReadOwnerIsCurrent(owner)) return null;
    const code = error instanceof ProtocolError ? error.code : "";
    if (code === "pane_not_found") {
      if (!paneReadOwnerIsCurrent(owner)) return null;
      applyPaneRead("", "");
      await refreshSnapshot();
      if (!paneReadOwnerIsCurrent(owner)) return null;
      if (currentScreen() === "pane" && openPaneId() && !dashboardStore.get().agents.some((agent) => agent.paneId === openPaneId())) {
        abandonOpenPane(t("err.paneGone"));
      }
      return null;
    }
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) {
      showError(messageOf(error));
      commitView();
    }
    return null;
  }
}

/** Stable pane-refresh identity: `unbindPaneRefresh` verifies its owner against it. */
const boundPaneRefresh: PaneRefresh = (request?: PaneRefreshRequest) => refreshPaneRead(request);

/** Idempotent bind; `startPolling` after an App unbind rebinds without a cached flag. */
function ensurePaneRefreshBound(): void {
  bindPaneRefresh(boundPaneRefresh);
}

paneReads = createPaneReadLane({
  perform: performPaneRead,
  deferPane: () => livePolling.deferPane(),
  setBusy: setPaneReadBusy,
  setPending: setPaneReadPending,
  now: monotonicNow,
});

export async function refreshPaneRead(request: PaneRefreshRequest = {}): Promise<PaneReadObservation | null> {
  ensurePaneRefreshBound();
  const session = liveSession();
  const viewVersion = liveView();
  if (!session || !openPaneId() || !session.isConnected() || !networkOnline() || document.visibilityState === "hidden") return null;
  if (currentScreen() !== "pane" || isFullTerminal()) return null;
  if (isAgentChat()) {
    const changed = await refreshAgentTrace();
    if (changed && shouldPullStatus(true, Date.now(), lastSnapshotAt())) void refreshSnapshot();
    return null;
  }
  return paneReads.request(paneReadOwner(session, viewVersion, openPaneId()), request);
}

export async function refreshFromSession(): Promise<void> {
  await Promise.all([
    refreshSnapshot(),
    currentScreen() === "board"
      ? refreshBoardPreviews()
      : currentScreen() === "pane" && openPaneId() && !isFullTerminal()
        ? refreshPaneRead()
        : Promise.resolve(),
  ]);
}

export function wakeLiveReads(): void {
  livePolling.wakePane();
}

export async function refreshPane(): Promise<void> {
  if (!liveSession() || !openPaneId() || !liveSession()!.isConnected()) {
    applyPaneRead("", "");
    commitView();
    return;
  }
  await refreshPaneRead();
}

export function startPolling(): void {
  ensurePaneRefreshBound();
  livePolling.start();
}

export function stopPolling(): void {
  livePolling.stop();
}
