import type { DashboardAgentCard, SnapshotWire } from "../../../lib/dashboard";
import { boardStateFromSnapshot, type BoardSpace, type BoardTab, type TabLayout } from "../../../lib/layout";

/**
 * Board projection and camera fields, owned as one pure duty.
 *
 * Pure projection from a snapshot into the board catalog/camera: reading feeds
 * `features/board/layout-store`, which owns the domain record and the actions
 * that change what the board shows. This module stays framework-neutral and
 * holds no record or subscriber; it only derives a fresh projection and its
 * camera defaults/refit rules.
 */
export type BoardViewState = {
  layouts: TabLayout[];
  workspaceList: BoardSpace[];
  tabList: BoardTab[];
  lastLayoutSig: string;
  boardWorkspaceId: string;
  boardTabId: string;
  boardScale: number;
  boardPanX: number;
  boardPanY: number;
  boardFitted: boolean;
  boardReturn: boolean;
};

export function initialBoardViewState(): BoardViewState {
  return {
    layouts: [],
    workspaceList: [],
    tabList: [],
    lastLayoutSig: "",
    boardWorkspaceId: "",
    boardTabId: "",
    boardScale: 1,
    boardPanX: 0,
    boardPanY: 0,
    boardFitted: false,
    boardReturn: false,
  };
}

export function applyBoardSnapshot(
  target: BoardViewState,
  snapshot: SnapshotWire,
  agents: DashboardAgentCard[],
): void {
  const board = boardStateFromSnapshot(snapshot, agents, target.boardWorkspaceId, target.boardTabId);
  target.layouts = board.layouts;
  target.workspaceList = board.workspaceList;
  target.tabList = board.tabList;
  target.lastLayoutSig = board.lastLayoutSig;
  target.boardWorkspaceId = board.boardWorkspaceId;
  target.boardTabId = board.boardTabId;
  if (board.refit) target.boardFitted = false;
}