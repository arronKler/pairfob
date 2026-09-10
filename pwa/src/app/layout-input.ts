import { isDesk } from "./viewport";
import { computeLayout, type LayoutDescriptor, type LayoutInput } from "./layout";
import { capabilitiesStore, operationBusy } from "../features/operations/capabilities-store";
import { connectionStore, phase } from "../features/connection/connection-store";
import { dashboardStore, selectedAgent } from "../features/dashboard/catalog-store";
import { currentScreen, navigationStore } from "./navigation-store";
import { preferencesStore, termFontPx } from "../features/settings/preferences-store";
import { isAgentChat, isFullTerminal, openPaneId, sessionStore } from "../features/session/session-store";

/**
 * The layout input, read from the domains that own it.
 *
 * These live owner reads include staged writes that have not been published yet,
 * so commit preparation describes the current intended composition.
 */
export function currentLayoutInput(): LayoutInput {
  const paneId = openPaneId();
  return {
    phase: phase(),
    screen: currentScreen(),
    fullTerminal: isFullTerminal(),
    agentChat: isAgentChat(),
    desk: isDesk(),
    hasSelectedPane: Boolean(paneId) && selectedAgent() !== undefined,
    termFontPx: termFontPx(),
    operationBusy: operationBusy(),
  };
}

/**
 * The layout input from published snapshots. A follower that updates the shell
 * on an ordinary typed action must not pick up a staged composition field the
 * commit has not published yet.
 */
export function publishedLayoutInput(): LayoutInput {
  const session = sessionStore.get();
  const paneId = session.paneId;
  return {
    phase: connectionStore.get().phase,
    screen: navigationStore.get().screen,
    fullTerminal: session.fullTerminal,
    agentChat: session.agentChat,
    desk: isDesk(),
    hasSelectedPane: Boolean(paneId) && dashboardStore.get().agents.some((agent) => agent.paneId === paneId),
    termFontPx: preferencesStore.get().termFontPx,
    operationBusy: capabilitiesStore.get().operationBusy,
  };
}

export function currentLayout(): LayoutDescriptor {
  return computeLayout(currentLayoutInput());
}
