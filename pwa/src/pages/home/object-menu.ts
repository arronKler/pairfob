/**
 * Herd object menu bridge.
 *
 * Opens the card and workspace-heading menus. It reads the domains' canonical
 * getters when the press lands (so the sheet shows the pane as it is now, not as
 * of the last paint) and turns each projected menu kind into the operation that
 * owns it. Presentation and ordering live in `features/dashboard`; this file is
 * the only part that knows about the mutation helpers.
 *
 * Reads come from the dashboard, preferences and capabilities domains' live
 * readers — a typed write is visible the moment it lands. The pin is the typed
 * `preferences.togglePanePin`, which publishes and lets the subscribed herd list
 * reorder itself without a repaint. The mutation helpers keep their current
 * ownership.
 */
import { capabilityEnabled } from "../../features/operations/capabilities-store";
import { liveAgents } from "../../features/dashboard/catalog-store";
import { listGroup, panePinned, togglePanePin } from "../../features/settings/preferences-store";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { openObjectMenu } from "../../features/dashboard/components/object-menu";
import { paneMenuModel, workspaceMenuModel, type ObjectMenuKind } from "../../features/dashboard/model/object-menu";
import { paneIsPinned, type AgentCard } from "../../lib/ranking";
import {
  closePane,
  closeTab,
  closeWorkspace,
  createSelectedTab,
  renamePane,
  renameTab,
  renameWorkspace,
} from "../../features/operations/controller";
import { openBoard } from "../board/board-bridge";

export function openListPaneMenu(agent: AgentCard): void {
  const model = paneMenuModel({
    agent,
    // Live owner records: the sheet shows the pane as it is when the press lands.
    agents: liveAgents() as DashboardAgentCard[],
    listGroup: listGroup(),
    pinned: paneIsPinned(panePinned(), agent.paneId),
    createTab: capabilityEnabled("create_tab"),
  });
  openObjectMenu(model, agent, runObjectMenuAction);
}

export function openListWorkspaceMenu(agent: AgentCard): void {
  const model = workspaceMenuModel({ agent, createTab: capabilityEnabled("create_tab") });
  if (!model) return;
  openObjectMenu(model, agent, runObjectMenuAction);
}

function runObjectMenuAction(kind: ObjectMenuKind, agent: AgentCard): void | Promise<void> {
  switch (kind) {
    case "pin":
      // Publishes: the subscribed herd list reorders itself, no repaint needed.
      togglePanePin(agent.paneId);
      return;
    case "newTabBeside":
    case "newTabInWorkspace":
      return createSelectedTab(agent);
    case "openBoard":
      return openBoard({ workspaceId: agent.workspaceId, tabId: agent.tabId });
    case "renamePane":
      return renamePane(agent);
    case "closePane":
      return closePane(agent);
    case "renameTab":
      return renameTab(agent);
    case "closeTab":
      return closeTab(agent);
    case "renameWorkspace":
      return renameWorkspace(agent);
    case "closeWorkspace":
      return closeWorkspace(agent);
  }
}
