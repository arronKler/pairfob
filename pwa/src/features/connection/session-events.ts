/**
 * Live-session event observation.
 *
 * Transport facts go through the connection domain. Snapshot/pane-read follow-up
 * is decided here and handed to ports; `#app` paint stays a shell adapter.
 */
import { recordConnectionDiagnostic } from "../../lib/protocol/connection-diagnostics";
import {
  noteP2PAttempt,
  noteRelayRtt,
  sessionTransport,
  setSessionTransport,
} from "./connection-store";
import { currentDaemonId, liveSession } from "../computers/catalog-store";
import { currentScreen } from "../../app/navigation-store";
import { isAgentChat, isFullTerminal, lastSnapshotAt, openPaneId } from "../session/session-store";
import type { ComputerSessions } from "../computers/session-pool";
import type { FinishedP2PAttemptObservation, LiveSession, SessionEvent } from "../../lib/protocol/client";
import { pokeRefreshAction, shouldPullStatus } from "./poll-schedule";

export type SessionEventPorts = {
  documentVisible(): boolean;
  commitView(): void;
  clearNotice(): void;
  showStatus(text: string, persist?: boolean): void;
  startPolling(): void;
  stopPolling(): void;
  refreshRuntime(): Promise<void>;
  refreshSnapshot(): Promise<void>;
  wakePane(): void;
  preloadFullTerminal(): void;
  handleGuidedEvent(event: SessionEvent): boolean;
  handleFullTerminalEvent(event: SessionEvent): boolean;
  handleInactiveTerminal(daemonId: string, session: LiveSession, code?: string): Promise<void>;
  handleActiveTerminal(event: SessionEvent): Promise<void>;
  sessionEventNotice(event: SessionEvent): string;
};

export function observeP2PAttempt(
  daemonId: string,
  session: LiveSession,
  attempt: FinishedP2PAttemptObservation,
  ports: SessionEventPorts,
): void {
  if (liveSession() !== session || currentDaemonId() !== daemonId) return;
  noteP2PAttempt(attempt);
  if (currentScreen() === "settings") ports.commitView();
}

export function observeSessionEvent(
  pool: ComputerSessions,
  daemonId: string,
  session: LiveSession,
  event: SessionEvent,
  ports: SessionEventPorts,
): void {
  if (!pool.has(daemonId, session)) return;
  if (liveSession() !== session || currentDaemonId() !== daemonId) {
    if (event.type === "terminal") void ports.handleInactiveTerminal(daemonId, session, event.code);
    return;
  }
  // The event still owns the live session: every publication below can reenter
  // and replace that owner, so each continuation revalidates before writing.
  const stillActive = () => liveSession() === session && currentDaemonId() === daemonId;
  if (ports.handleGuidedEvent(event)) return;
  if (ports.handleFullTerminalEvent(event) && (event.type === "terminal_frame" || event.type === "terminal_closed")) return;
  if (event.type === "latency" && typeof event.rttMs === "number") {
    const previousTransport = sessionTransport();
    noteRelayRtt(Math.max(0, Math.round(event.rttMs)));
    if (!stillActive()) return;
    const next = event.transport ?? previousTransport;
    if (next === "p2p" || next === "relay") setSessionTransport(next);
    if (!stillActive()) return;
    if (next === "p2p" && previousTransport !== "p2p") ports.preloadFullTerminal();
    if (currentScreen() === "settings") ports.commitView();
    return;
  }
  if (event.type === "poke" && ports.documentVisible()) {
    const action = pokeRefreshAction(currentScreen(), openPaneId(), event.paneId, event.reason);
    if (action === "runtime") void ports.refreshRuntime();
    else if (action === "snapshot") {
      void ports.refreshSnapshot();
      if (currentScreen() === "board" || (currentScreen() === "pane" && !isFullTerminal() && event.paneId === openPaneId())) {
        ports.wakePane();
      }
    } else if (action === "paneread") {
      ports.wakePane();
      if (isAgentChat() && shouldPullStatus(true, Date.now(), lastSnapshotAt())) void ports.refreshSnapshot();
    }
    return;
  }
  if (event.type === "checking" || ((event.type === "connected" || event.type === "disconnected" || event.type === "reconnecting") && session.isChecking?.())) {
    ports.stopPolling();
    if (!stillActive()) return;
    ports.clearNotice();
    if (stillActive()) ports.commitView();
    return;
  }
  if (event.type === "connected") {
    ports.clearNotice();
    if (!stillActive()) return;
    ports.startPolling();
    ports.commitView();
    recordConnectionDiagnostic({ event: "view_committed" });
    if (ports.documentVisible()) void ports.refreshRuntime();
    return;
  }
  if (event.type === "disconnected" || event.type === "reconnecting") {
    noteRelayRtt(null);
    if (!stillActive()) return;
    setSessionTransport("relay");
    if (!stillActive()) return;
    ports.stopPolling();
    ports.showStatus(ports.sessionEventNotice(event), true);
    if (!stillActive()) return;
    ports.commitView();
    return;
  }
  if (event.type === "terminal") {
    void ports.handleActiveTerminal(event);
  }
}
