/**
 * Dashboard feature actions.
 *
 * Narrow, named intents the herd screen can fire. Everything that reads or
 * writes the application record (the collapse map, navigation to the board, the
 * press-time busy/connection guard) arrives through `HerdActionPorts`, so this
 * module and the components above it stay free of the global state bridge.
 */
import { openComputers } from "../computers/actions";
import type { AgentCard } from "../../lib/ranking";
import type { EmptySessionAction } from "../../lib/ui-model";
import { openPane, reconnectLiveSessions } from "../connection/controller";
import { startNewConversation } from "../operations/controller";
import { openSettings } from "../settings/actions";

export type HerdActionPorts = {
  /**
   * Read at press time, never at render time: a long press that starts while
   * the app is idle must still be refused once a mutation is in flight.
   */
  canOpenMenu(): boolean;
  /** `groupIds` is the order the clicked list was rendered from. */
  toggleGroup(groupId: string, groupIds: string[]): void;
  openBoard(): void;
  /** Hand the outgoing card title to the view transition that opens the pane. */
  shareTitle(element: HTMLElement | null): void;
  /** Object menus read the record when the press lands, so the page owns them. */
  openPaneMenu(agent: AgentCard): void;
  openWorkspaceMenu(agent: AgentCard): void;
};

export type HerdActions = {
  openPaneFromCard(paneId: string, title: HTMLElement | null): void;
  openPaneMenu(agent: AgentCard): void;
  openWorkspaceMenu(agent: AgentCard | undefined): void;
  toggleGroup(groupId: string, groupIds: string[]): void;
  createConversation(): void;
  openBoard(): void;
  openSettings(): void;
  openComputers(): void;
  runEmptyAction(kind: EmptySessionAction): void;
};

export function createHerdActions(ports: HerdActionPorts): HerdActions {
  return {
    openPaneFromCard(paneId, title) {
      ports.shareTitle(title);
      void openPane(paneId);
    },
    openPaneMenu(agent) {
      if (!ports.canOpenMenu()) return;
      ports.openPaneMenu(agent);
    },
    openWorkspaceMenu(agent) {
      if (!agent || !ports.canOpenMenu()) return;
      ports.openWorkspaceMenu(agent);
    },
    toggleGroup(groupId, groupIds) {
      ports.toggleGroup(groupId, groupIds);
    },
    createConversation() {
      void startNewConversation();
    },
    openBoard() {
      ports.openBoard();
    },
    openSettings() {
      openSettings();
    },
    openComputers() {
      openComputers();
    },
    runEmptyAction(kind) {
      if (kind === "create") void startNewConversation();
      else if (kind === "retry") reconnectLiveSessions("probe");
      else openSettings();
    },
  };
}
