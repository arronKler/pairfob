import "./layout/desk-empty";
import { openCommandPalette } from "../features/command-palette";
import { commandPalettePorts } from "../features/command-palette/ports";
import { DesktopScreen } from "../features/remote-desktop/desktop-surface";
import { openSettingsSection, selectNetworkMode } from "../features/settings/actions";
import { useHerdAttentionCount } from "../pages/home";
import { leaveDesktop, toggleDesktopLayoutRail } from "./desktop-nav";
import { commitView } from "./host";
import { goToScreen } from "./navigation-store";

function openAttentionFromDesktop(): void {
  if (commandPalettePorts()) {
    openCommandPalette();
    return;
  }
  goToScreen("home");
  commitView();
}

export function DesktopRoute({ railCollapsed }: { railCollapsed?: boolean }) {
  const attentionCount = useHerdAttentionCount();
  return (
    <DesktopScreen
      onBack={leaveDesktop}
      onOpenSettings={() => openSettingsSection("connection")}
      onRetryDirect={() => void selectNetworkMode("p2p")}
      onToggleRail={railCollapsed !== undefined ? toggleDesktopLayoutRail : undefined}
      railCollapsed={railCollapsed}
      attentionCount={attentionCount}
      onOpenAttention={openAttentionFromDesktop}
    />
  );
}
