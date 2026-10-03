import { LayoutDashboard, MessageSquare, Settings } from "lucide-react";
import { useSyncExternalStore } from "react";
import { t } from "../../lib/i18n";
import { prefersReducedMotion } from "../../shared/ui/dom/motion";
import { needsDaemonUpdate, subscribeDaemonUpdates } from "../../features/settings/daemon-update";
import { openSettings } from "../../features/settings/actions";
import { setSettingsSection } from "../../features/settings/settings-section";
import { leaveBoardForTab, openBoard } from "../../pages/board/board-bridge";
import { useHerdAttentionCount } from "../../pages/home";
import { commitView } from "../host";
import { currentScreen, goToScreen } from "../navigation-store";
import type { LayoutMode } from "../layout";

export type TabId = "sessions" | "board" | "settings";

function activeTab(mode: LayoutMode): TabId {
  return mode === "board" ? "board" : mode === "settings" ? "settings" : "sessions";
}

/**
 * Move between the three phone tab roots. They sit at the same navigation
 * depth, so the move cross-fades; leaving the board first releases its scroll
 * ownership. Tapping the active Sessions tab returns the list to its top.
 */
export function switchTab(target: TabId): void {
  const from = currentScreen();
  const fromTab: TabId = from === "board" ? "board" : from === "settings" ? "settings" : "sessions";
  if (fromTab === target) {
    // The phone list scrolls the window; a second tap on its tab returns to the top.
    if (target === "sessions") window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return;
  }
  if (from === "board") leaveBoardForTab();
  if (from === "settings") setSettingsSection("overview");
  if (target === "board") {
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
 * Phone bottom navigation: Sessions / Board / Settings. Desktop keeps the rail.
 * While the phone is still booting or reconnecting the bar is already in place,
 * but only Sessions is reachable: there is no board or session state to show.
 */
export function TabBar({ mode }: { mode: LayoutMode }) {
  const active = activeTab(mode);
  // Not connected yet (booting, or the single computer cannot be reached).
  const locked = mode === "boot" || mode === "pick";
  const attention = useHerdAttentionCount();
  const update = useSyncExternalStore(subscribeDaemonUpdates, needsUpdate);
  // Before the session is live, any count would be left over from a previous one.
  const count = locked ? 0 : attention;
  const tabs: Array<{ id: TabId; label: string; icon: typeof MessageSquare; badge?: string; dot?: boolean; aria?: string }> = [
    { id: "sessions", label: t("tabs.panes"), icon: MessageSquare,
      badge: count > 0 ? String(count) : undefined,
      aria: count > 0 ? t("tabs.attentionAria", { count: String(count) }) : undefined },
    { id: "board", label: t("tabs.board"), icon: LayoutDashboard },
    { id: "settings", label: t("tabs.settings"), icon: Settings, dot: update,
      aria: update ? t("tabs.updateAria") : undefined },
  ];
  return (
    <nav className="tab-bar" aria-label={t("tabs.aria")}>
      {tabs.map(({ id, label, icon: Icon, badge, dot, aria }) => (
        <button
          key={id}
          type="button"
          className={`tab-bar-item${active === id ? " on" : ""}`}
          aria-current={active === id ? "page" : undefined}
          disabled={locked && id !== "sessions"}
          onClick={() => { if (!locked) switchTab(id); }}
        >
          <span className="tab-bar-icon">
            <Icon size={22} aria-hidden="true" />
            {badge ? <span className="tab-bar-badge" aria-hidden="true">{badge}</span> : null}
            {dot ? <span className="tab-bar-dot" aria-hidden="true" /> : null}
          </span>
          <span className="tab-bar-label">{label}</span>
          {aria ? <span className="sr-only">{aria}</span> : null}
        </button>
      ))}
    </nav>
  );
}
