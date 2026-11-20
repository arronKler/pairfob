import { openBoard, leaveBoardForTab } from "../pages/board/board-bridge";
import { bindSessionOwnerFromLive } from "../features/session/bind-live";
import { applyComposeDraft, bumpViewIncarnation, parkComposeView } from "../features/session/drafts/compose-drafts";
import { openPaneId } from "../features/session/session-store";
import { setSettingsSection } from "../features/settings/settings-section";
import { commitView } from "./host";
import {
  currentScreen,
  desktopFrom,
  goToScreen,
  setDesktopFrom,
  setDesktopRailCollapsed,
  toggleDesktopRail,
} from "./navigation-store";
import { isDesk, isRoomy } from "./viewport";

/**
 * Remote desktop navigation actions.
 *
 * Entering the desktop surface keeps the open pane and scroll context intact
 * without triggering a terminal PTY resize; leaving returns to the prior screen
 * and rebinds the session owner when returning to an open pane.
 */
export function openDesktop(): void {
  const from = currentScreen();
  if (from === "desktop") return;
  if (from === "pane") parkComposeView();
  if (from === "board") leaveBoardForTab();
  if (from === "settings") setSettingsSection("overview");
  setDesktopFrom(from);
  setDesktopRailCollapsed(!isRoomy());
  goToScreen("desktop");
  commitView();
}

export function leaveDesktop(): void {
  const target = desktopFrom();
  const returnToPane = target === "pane"
    || (isDesk() && target !== "settings" && target !== "board" && target !== "quota" && target !== "computers");
  if (returnToPane && openPaneId()) {
    bumpViewIncarnation();
    goToScreen("pane");
    bindSessionOwnerFromLive();
    applyComposeDraft();
    commitView();
    return;
  }
  if (target === "board") {
    void openBoard();
    return;
  }
  goToScreen(target === "desktop" || target === "workspace" ? "home" : target);
  commitView();
}

export function toggleDesktopLayoutRail(): void {
  toggleDesktopRail(!isRoomy());
}
