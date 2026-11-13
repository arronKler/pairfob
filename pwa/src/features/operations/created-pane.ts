import { currentScreen } from "../../app/navigation-store";
import { boardStore, focusBoard, selectBoardTab, selectBoardWorkspace } from "../board/layout-store";
import { openPaneWithOwner, refreshCatalogQuietly, refreshFromSession } from "../connection/controller";
import { markCreatedPane } from "../session/session-store";
import { ownsComputer, ownsOperationView } from "./live-run";
import { type OperationOwner } from "./run";

/**
 * Where the reader lands after an operation made a pane: on it, or on its place
 * on the board.
 *
 * The mutation's answer already names what it made, including the agent kind it
 * started, so the destination opens from that answer. The dashboard Snapshot is
 * reconciliation and runs alongside instead of in front: waiting for it first
 * held every create and split sheet on a full catalog read before the new pane
 * could even be selected.
 */
export async function selectCreatedPane(
  result: { pane_id?: string; workspace_id?: string; tab_id?: string },
  owner: OperationOwner,
  /** The kind the create started ("" for a plain terminal); absent when unknown. */
  agentKind?: string,
): Promise<void> {
  const paneId = typeof result.pane_id === "string" && result.pane_id ? result.pane_id : "";
  if (!ownsOperationView(owner)) return;
  if (currentScreen() === "board") {
    // The board reveals by catalog identity: the tile does not exist until the
    // fold adds it. Focusing ids the catalog does not hold would blank the
    // canvas and could be reset by the next fold, so this path keeps waiting.
    await refreshFromSession();
    if (!ownsOperationView(owner)) return;
    const workspaceId = typeof result.workspace_id === "string" ? result.workspace_id : "";
    const tabId = typeof result.tab_id === "string" ? result.tab_id : "";
    if (workspaceId && tabId) focusBoard(workspaceId, tabId);
    else if (workspaceId) selectBoardWorkspace(workspaceId, boardStore.get().boardTabId);
    else if (tabId) selectBoardTab(tabId);
    return;
  }
  // The mutation answered; reconcile the catalog alongside instead of in
  // front. Mark first so a fold that started before the create cannot treat
  // the pane it names as gone.
  if (paneId) markCreatedPane(paneId);
  void refreshCatalogQuietly().catch(() => {});
  if (paneId) {
    // The dashboard does not know this pane yet. Say what the create already
    // knows, or a default agent-chat mode would land in guided and stay there
    // until the pane is opened again.
    const agent = agentKind === undefined ? undefined
      : { paneId, hasAgent: agentKind !== "", agent: agentKind };
    const navigation = await openPaneWithOwner(paneId, undefined, agent ? { agent } : undefined);
    if (ownsComputer(owner) && navigation?.isCurrent()) {
      owner.scope = navigation.scope;
      owner.incarnation = navigation.incarnation;
    }
  }
}
