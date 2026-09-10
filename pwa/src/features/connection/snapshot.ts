/**
 * Snapshot observation: one in-flight Snapshot, one queued follow-up.
 *
 * Applies the daemon snapshot through the dashboard and preferences owners
 * (`applySnapshot`, `applyHerdTouches`). Chrome patches and `#app` classes stay
 * ports until core's declarative shell owns them.
 */
import { boardStore } from "../board/layout-store";
import { applySnapshot, dashboardStore, setRefreshBusy } from "../dashboard/catalog-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { applyHerdTouches } from "../settings/preferences-store";
import {
  applyPaneRead,
  isAgentChat,
  isFullTerminal,
  noteSnapshotAt,
  openPaneId,
  queueSnapshot,
  selectPane,
  takeQueuedSnapshot,
} from "../session/session-store";
import { t } from "../../lib/i18n";
import { choosePane, type SnapshotWire } from "../../lib/dashboard";
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
  messageOf(error: unknown): string;
  commitView(): void;
  now(): number;
};

function viewIsCurrent(session: LiveSession, viewVersion: number, ports: SnapshotPorts): boolean {
  return liveViewIsCurrent(session, viewVersion, ports.currentLive());
}

function dropGonePane(): void {
  selectPane("");
  applyPaneRead("", "");
}

export async function refreshSnapshot(ports: SnapshotPorts): Promise<void> {
  const session = ports.currentLive();
  const viewVersion = liveView();
  if (!session || !session.isConnected() || !ports.networkOnline() || !ports.documentVisible()) return;
  if (dashboardStore.get().refreshBusy) {
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
    const { previous, unchanged } = applySnapshot(snapshot);
    // applySnapshot publishes the dashboard: a subscriber retiring this owner
    // there (a newer computer/session/view) must not let the old status touch
    // persist under the replacement daemon's key. Revalidate before the second
    // owned domain write; checking only after both publications is too late.
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    applyHerdTouches(previous, dashboardStore.get().agents);
    // The dashboard/preferences publications can reenter too.
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    const layoutUnchanged = previousLayoutSig === boardStore.get().lastLayoutSig;
    if (await ports.openPendingNotification(ports.openPane)) return;
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    const screen = currentScreen();
    const agents = dashboardStore.get().agents;
    if (screen === "pane") {
      selectPane(choosePane(openPaneId(), agents));
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
      if (ports.isDesk()) ports.commitView();
      return;
    }
    if (screen === "workspace" && openPaneId() && !agents.some((agent) => agent.paneId === openPaneId())) {
      setScreen("home");
      dropGonePane();
      ports.showError(t("err.paneGone"), true);
      ports.commitView();
      return;
    }
    if (openPaneId() && !agents.some((agent) => agent.paneId === openPaneId())) dropGonePane();
    if (screen === "board") {
      if (unchanged && layoutUnchanged) return;
      ports.commitView();
      return;
    }
    if ((screen === "home" || screen === "workspace" || screen === "settings" || screen === "computers") && unchanged) return;
    ports.commitView();
  } catch (error) {
    if (!viewIsCurrent(session, viewVersion, ports)) return;
    if (!(error instanceof ProtocolError && ["reconnecting", "disconnected"].includes(error.code))) {
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
