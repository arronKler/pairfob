/**
 * Snapshot observation: one in-flight Snapshot, one queued follow-up.
 *
 * Applies the daemon snapshot through the dashboard and preferences owners
 * (`applySnapshot`, `applyHerdTouches`). Chrome patches and `#app` classes stay
 * ports until core's declarative shell owns them.
 */
import { boardStore } from "../board/layout-store";
import { applySnapshot, dashboardStore, refreshBusy, setRefreshBusy } from "../dashboard/catalog-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { applyHerdTouches } from "../settings/preferences-store";
import {
  applyPaneRead,
  clearCreatedPane,
  createdPaneAwaitingCatalog,
  isAgentChat,
  isFullTerminal,
  noteSnapshotAt,
  openPaneId,
  queueSnapshot,
  selectPane,
  takeQueuedSnapshot,
} from "../session/session-store";
import { t } from "../../lib/i18n";
import { choosePane, type DashboardAgentCard, type SnapshotWire } from "../../lib/dashboard";
import { invalidateAgentTraceOwner } from "../session/chat/trace-store";
import { batch } from "../../shared/model/domain-store";
import { ProtocolError, type LiveSession } from "../../lib/protocol/client";
import { liveView, liveViewIsCurrent } from "./generations";

export type SnapshotPorts = {
  currentLive(): LiveSession | null;
  networkOnline(): boolean;
  documentVisible(): boolean;
  isDesk(): boolean;
  openPendingNotification(open: (paneId: string) => Promise<void>): Promise<boolean>;
  openPane(paneId: string): Promise<void>;
  abandonOpenPane(message: string): void;
  syncFullTerminalChrome(): void;
  patchAgentChat(): boolean;
  patchChromeTitle(): void;
  showError(text: string, persist?: boolean): void;
  showStatus(text: string): void;
  messageOf(error: unknown): string;
  commitView(): void;
  now(): number;
};

/** The background lane folds the catalog; it never paints, navigates or reads a pane. */
export type SnapshotStatusPorts = Pick<SnapshotPorts, "currentLive" | "networkOnline" | "now">;

type LiveOwnerPorts = Pick<SnapshotPorts, "currentLive">;

function viewIsCurrent(session: LiveSession, viewVersion: number, ports: LiveOwnerPorts): boolean {
  return liveViewIsCurrent(session, viewVersion, ports.currentLive());
}

function dropGonePane(): void {
  selectPane("");
  applyPaneRead("", "");
}

function occupantChanged(before: DashboardAgentCard, after: DashboardAgentCard | undefined): boolean {
  if (!after) return true;
  return before.runtimeSession !== after.runtimeSession ||
    before.terminalId !== after.terminalId ||
    before.agentInstanceId !== after.agentInstanceId;
}

function invalidateChangedPaneOwners(
  previous: readonly DashboardAgentCard[],
  next: readonly DashboardAgentCard[],
  activePaneId: string,
): void {
  const current = new Map(next.map((agent) => [agent.paneId, agent]));
  for (const before of previous) {
    if (occupantChanged(before, current.get(before.paneId))) {
      invalidateAgentTraceOwner(before.paneId, before.paneId === activePaneId);
    }
  }
}

export async function refreshSnapshot(ports: SnapshotPorts): Promise<void> {
  const session = ports.currentLive();
  const viewVersion = liveView();
  if (!session || !session.isConnected() || !ports.networkOnline() || !ports.documentVisible()) return;
  if (refreshBusy()) {
    queueSnapshot();
    return;
  }
  setRefreshBusy(true);
  // The busy publication can reenter: a subscriber retiring the owner there
  // must prevent the old owner's RPC from firing at all.
  if (!viewIsCurrent(session, viewVersion, ports)) return;
  try {
    const snapshot = (await session.snapshot()) as SnapshotWire;
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    noteSnapshotAt(ports.now());
    // The timestamp publication can reenter and install a replacement owner;
    // the old response must not apply onto it.
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    const previousLayoutSig = boardStore.get().lastLayoutSig;
    const activePaneId = openPaneId();
    let applied!: ReturnType<typeof applySnapshot>;
    batch(() => {
      applied = applySnapshot(snapshot);
      invalidateChangedPaneOwners(applied.previous, dashboardStore.get().agents, activePaneId);
    });
    const { previous, unchanged } = applied;
    // The atomic dashboard/cache publication can reenter and retire this owner;
    // there (a newer computer/session/view) must not let the old status touch
    // persist under the replacement daemon's key. Revalidate before the second
    // owned domain write; checking only after both publications is too late.
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    // A fold read before the create may lack the pane the mutation already
    // answered with. Keep its recency while that is possible, and end the
    // grace only when a fold actually carries the pane.
    const created = createdPaneAwaitingCatalog();
    applyHerdTouches(previous, dashboardStore.get().agents, Date.now(), created);
    if (created && dashboardStore.get().agents.some((agent) => agent.paneId === created)) clearCreatedPane();
    // The dashboard/preferences publications can reenter too.
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    const layoutUnchanged = previousLayoutSig === boardStore.get().lastLayoutSig;
    if (await ports.openPendingNotification(ports.openPane)) return;
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    const screen = currentScreen();
    const agents = dashboardStore.get().agents;
    if (screen === "pane") {
      // A pane the create just made is absent from a fold that started before
      // it existed; that is not the pane going away.
      const created = createdPaneAwaitingCatalog();
      selectPane(created && created === openPaneId() ? created : choosePane(openPaneId(), agents));
      if (!viewIsCurrent(session, viewVersion, ports)) return;
      if (!openPaneId()) {
        ports.abandonOpenPane(t("err.paneGone"));
        return;
      }
      if (isFullTerminal()) ports.syncFullTerminalChrome();
      if (isAgentChat()) {
        if (!ports.patchAgentChat()) ports.commitView();
        return;
      }
      ports.patchChromeTitle();
      // An idle poll that moved nothing prepares the frame it already
      // publishes; a selection that did move requests its own commit.
      if (ports.isDesk() && !(unchanged && layoutUnchanged)) ports.commitView();
      return;
    }
    if (screen === "workspace" && openPaneId() && !agents.some((agent) => agent.paneId === openPaneId())
      && createdPaneAwaitingCatalog() !== openPaneId()) {
      setScreen("home");
      dropGonePane();
      ports.showError(t("err.paneGone"), true);
      ports.commitView();
      return;
    }
    if (openPaneId() && !agents.some((agent) => agent.paneId === openPaneId())
      && createdPaneAwaitingCatalog() !== openPaneId()) dropGonePane();
    if (screen === "board") {
      if (unchanged && layoutUnchanged) return;
      ports.commitView();
      return;
    }
    if ((screen === "home" || screen === "workspace" || screen === "settings" || screen === "computers") && unchanged) return;
    ports.commitView();
  } catch (error) {
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    if (error instanceof ProtocolError && error.code === "timeout") {
      // A deadline expiry is repaired by the connection, not by the reader: the
      // poll retries by itself. A path check reports its own progress.
      if (!session.verifyPath?.()) ports.showStatus(t("err.retrying"));
    } else if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) {
      ports.showError(ports.messageOf(error));
    }
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    ports.commitView();
  } finally {
    if (viewIsCurrent(session, viewVersion, ports)) {
      setRefreshBusy(false);
      if (takeQueuedSnapshot()) void refreshSnapshot(ports);
    }
  }
}

/**
 * The hidden-page attention lane. An agent-status poke reaches here when the
 * page holds the notification keep-alive; folding the Snapshot into the
 * dashboard catalog is all the local notification producer needs, so nothing
 * visible, navigational or pane-reading runs. A foreground Snapshot in flight
 * already owns the busy flag and will update the catalog itself.
 *
 * `isConnected()` is false on a hidden page by design: the session keeps
 * `checking` until the reader returns and the probe verifies the path. The
 * answer reads stale there, not dead, and the poke that reached this lane
 * arrived on the transport, so the session is what to ask, not the page.
 */
export async function refreshSnapshotInBackground(ports: SnapshotStatusPorts): Promise<void> {
  const session = ports.currentLive();
  const viewVersion = liveView();
  if (!session || !ports.networkOnline() || refreshBusy()) return;
  setRefreshBusy(true);
  if (!viewIsCurrent(session, viewVersion, ports)) {
    // Nothing was sent; leaving the flag would strand the lane for good.
    setRefreshBusy(false);
    return;
  }
  try {
    const snapshot = (await session.snapshot()) as SnapshotWire;
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    noteSnapshotAt(ports.now());
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    batch(() => {
      const applied = applySnapshot(snapshot);
      // Occupant caches must not survive a background fold, or the next
      // visible refresh sees no change and keeps a stale trace.
      invalidateChangedPaneOwners(applied.previous, dashboardStore.get().agents, openPaneId());
    });
  } catch {
    // A hidden page has no screen to report on; the visible lane owns errors.
  } finally {
    if (viewIsCurrent(session, viewVersion, ports)) setRefreshBusy(false);
  }
}
