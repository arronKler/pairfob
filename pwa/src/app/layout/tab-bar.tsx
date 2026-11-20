import { TabBarView } from "./tab-bar-view";
import { useSyncExternalStore } from "react";
import { useDesktopStatus } from "../../features/remote-desktop/desktop-status";
import { usePresence } from "../../shared/react/use-presence";
import { MOTION_MS, prefersReducedMotion } from "../../shared/ui/dom/motion";
import { needsDaemonUpdate, subscribeDaemonUpdates } from "../../features/settings/daemon-update";
import { openSettings } from "../../features/settings/actions";
import { setSettingsSection } from "../../features/settings/settings-section";
import { leaveBoardForTab, openBoard } from "../../pages/board/board-bridge";
import { useHerdAttentionCount } from "../../pages/home";
import { openDesktop } from "../desktop-nav";
import { commitView } from "../host";
import { currentScreen, goToScreen } from "../navigation-store";
import type { LayoutMode } from "../layout";

import type { TabId } from "./tab-bar-view";
export type { TabId } from "./tab-bar-view";

/**
 * Move between the four phone tab roots. They sit at the same navigation
 * depth, so the move cross-fades; leaving the board first releases its scroll
 * ownership. Tapping the active Sessions tab returns the list to its top.
 */
export function switchTab(target: TabId): void {
  const from = currentScreen();
  const fromTab: TabId = from === "desktop" ? "desktop" : from === "board" ? "board" : from === "settings" ? "settings" : "sessions";
  if (fromTab === target) {
    // The phone list scrolls the window; a second tap on its tab returns to the top.
    if (target === "sessions") window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return;
  }
  if (from === "board") leaveBoardForTab();
  if (from === "settings") setSettingsSection("overview");
  if (target === "desktop") {
    openDesktop();
  } else if (target === "board") {
    void openBoard();
  } else if (target === "settings") {
    openSettings();
  } else {
    goToScreen("home");
    commitView();
  }
}

function needsUpdate(): boolean {
  return needsDaemonUpdate();
}

/**
 * Phone bottom navigation: Sessions / Desktop / Board / Settings. Desktop keeps the rail.
 * While the phone is still booting or reconnecting the bar is already in place,
 * but only Sessions is reachable. While live on the desktop route, the bar hides
 * smoothly so remote control gets full viewport height.
 */
export function TabBar({ mode }: { mode: LayoutMode }) {
  // Not connected yet (booting, or the single computer cannot be reached).
  const locked = mode === "boot" || mode === "pick";
  const attention = useHerdAttentionCount();
  const update = useSyncExternalStore(subscribeDaemonUpdates, needsUpdate);
  const desktop = useDesktopStatus();
  const shown = !(mode === "desktop" && desktop.live);
  const presence = usePresence(shown, MOTION_MS.element);
  if (!presence.mounted) return null;
  // Before the session is live, any count would be left over from a previous one.
  const count = locked ? 0 : attention;
  return <TabBarView mode={mode} count={count} update={update}
    showDesktop={!locked && (desktop.supported || mode === "desktop")}
    desktopPip={locked ? undefined : desktop.pip} leaving={presence.leaving} onSwitch={switchTab} />;
}
