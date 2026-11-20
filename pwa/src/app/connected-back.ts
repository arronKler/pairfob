import { topDialogBack } from "../shared/ui/overlay/back";
import { closeWorkspaceDetail } from "../features/workspace/actions";
import { workspaceBackAction } from "../features/workspace/back";
import { leaveWorkspaceInspector } from "../features/workspace/inspector";
import { getWorkspaceSnapshot, subscribeWorkspace } from "../features/workspace/store";
import { listBeside } from "../features/workspace/list-beside";
import { leaveComputers } from "../features/computers/actions";
import { computersBackTarget } from "../features/computers/model";
import { openPaneId } from "../features/session/session-store";
import { leaveSettings } from "../features/settings/actions";
import { settingsSection, subscribeSettingsSection } from "../features/settings/settings-section";
import { leaveBoardForList } from "../pages/board/board-bridge";
import { travelSettingsSection } from "../pages/settings/section-travel";
import { goBackFromPane } from "../features/session/pane-actions";
import { getDesktopLive } from "../features/remote-desktop/desktop-status";
import { leaveDesktop } from "./desktop-nav";
import { currentScreen, computersFrom, desktopFrom, goToScreen } from "./navigation-store";
import { getAppFrame } from "./frame";
import { commitView } from "./host";

/** Use existing navigation actions: they own pending reads, drafts, and focus. */
export function systemBackAction(): (() => void | Promise<void>) | null {
  const dialog = topDialogBack();
  if (dialog) return dialog;
  const layout = getAppFrame().layout;
  if (!layout || layout.mode === "boot" || layout.mode === "connect" || layout.mode === "pick") return null;
  const screen = currentScreen();
  if (screen === "workspace" || layout.shell.inspector) {
    const workspace = getWorkspaceSnapshot();
    // A column's detail has its own Close; a wide workspace header leaves the
    // whole screen. A narrow screen uncovers the list, then climbs folders.
    if (workspace.view !== "browser" && (layout.shell.inspector || !listBeside())) return closeWorkspaceDetail;
    return screen === "workspace" ? workspaceBackAction(workspace, listBeside()) : leaveWorkspaceInspector;
  }
  if (screen === "pane") return () => goBackFromPane();
  if (screen === "board" && layout.shell.railHidden) return leaveBoardForList;
  if (screen === "desktop") {
    if (layout.shell.desk || getDesktopLive() || desktopFrom() === "settings" || desktopFrom() === "pane") {
      return leaveDesktop;
    }
    return null;
  }
  if (screen === "settings") {
    if (settingsSection() !== "overview") return () => travelSettingsSection("overview");
    return layout.shell.desk ? leaveSettings : null;
  }
  if (screen === "computers") return () => leaveComputers(computersBackTarget({
    computersFrom: computersFrom(), desk: layout.shell.desk, paneId: openPaneId(),
  }));
  if (screen === "quota") return () => {
    goToScreen("settings");
    commitView();
  };
  // Tabs are roots. Back here belongs to the browser/OS.
  return null;
}

export function subscribeConnectedBack(listener: () => void): () => void {
  const stops = [subscribeWorkspace(listener), subscribeSettingsSection(listener)];
  return () => { for (const stop of stops) stop(); };
}
