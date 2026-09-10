import type { DashboardAgentCard, SnapshotWire } from "../../lib/dashboard";
import type { TabLayoutView } from "../../lib/layout";
import { applyBoardSnapshot, initialBoardViewState, type BoardViewState } from "./model/snapshot-state";
import { createDomain, detach, type DomainView } from "../../shared/model/domain-store";

/**
 * Board domain: the workspace/tab catalog projection and the board camera.
 * The projection itself stays pure in `model/snapshot-state`; this module owns
 * the record and the actions that change what the board shows.
 */
export type BoardRecord = BoardViewState;

/** The frozen published shape; live action-time readers return the same fields. */
type BoardSnapshot = DomainView<BoardRecord>;

const boardDomain = createDomain<BoardRecord>("board", initialBoardViewState());
export const boardStore = boardDomain.store;
const { read, write, stage } = boardDomain.controller;


/** Fold a fresh daemon snapshot into the catalog and camera focus. */
export function projectSnapshot(snapshot: SnapshotWire, agents: DashboardAgentCard[]): void {
  write((record) => {
    applyBoardSnapshot(record, snapshot, agents);
  });
}

/**
 * The board's tab layouts, detached for action-time consumers (terminal fit
 * sizing). A caller gets a view it can hold and read, never the domain's own
 * array to edit behind its back.
 */
export function boardLayouts(): readonly TabLayoutView[] {
  return detach(read().layouts);
}

/**
 * Live catalog for action-time entry and preview decisions. This is NOT a React
 * snapshot: it reads the owner record, so a typed focus/catalog action is visible
 * the moment it lands — even while a composition transaction (a staged
 * navigation) holds publication. React projections keep reading `boardStore.get()`.
 */
export function liveBoardCatalog(): {
  workspaceId: BoardSnapshot["boardWorkspaceId"];
  tabId: BoardSnapshot["boardTabId"];
  layouts: BoardSnapshot["layouts"];
  workspaceList: BoardSnapshot["workspaceList"];
  tabList: BoardSnapshot["tabList"];
} {
  const record = read();
  return {
    workspaceId: record.boardWorkspaceId,
    tabId: record.boardTabId,
    layouts: detach(record.layouts),
    workspaceList: detach(record.workspaceList),
    tabList: detach(record.tabList),
  };
}

/** The live camera for imperative gesture and toolbar reads; never a React snapshot. */
export function liveBoardCamera(): {
  scale: BoardSnapshot["boardScale"];
  panX: BoardSnapshot["boardPanX"];
  panY: BoardSnapshot["boardPanY"];
  fitted: BoardSnapshot["boardFitted"];
} {
  const record = read();
  return {
    scale: record.boardScale,
    panX: record.boardPanX,
    panY: record.boardPanY,
    fitted: record.boardFitted,
  };
}

/** Focus the board on a workspace/tab, invalidating a fitted camera. */
export function focusBoard(workspaceId: string, tabId: string): void {
  write((record) => {
    record.boardWorkspaceId = workspaceId;
    record.boardTabId = tabId;
    record.boardFitted = false;
  });
}

export function selectBoardWorkspace(workspaceId: string, tabId: string): void {
  if (read().boardWorkspaceId === workspaceId) return;
  focusBoard(workspaceId, tabId);
}

export function selectBoardTab(tabId: string): void {
  if (read().boardTabId === tabId) return;
  write((record) => {
    record.boardTabId = tabId;
    record.boardFitted = false;
  });
}

/** Camera written by the canvas gesture/fit controller. */
export function setBoardCamera(camera: { scale: number; panX: number; panY: number }, fitted = true): void {
  write((record) => {
    record.boardScale = camera.scale;
    record.boardPanX = camera.panX;
    record.boardPanY = camera.panY;
    record.boardFitted = fitted;
  });
}

export function boardReturn(): boolean {
  return read().boardReturn;
}

export function clearBoardReturn(): void {
  if (!read().boardReturn) return;
  write((record) => {
    record.boardReturn = false;
  });
}

/** Staged form for a transaction that also changes the composition. */
export function stageBoardReturnCleared(): void {
  if (!read().boardReturn) return;
  stage((record) => {
    record.boardReturn = false;
  });
}

/** A pane opened from a board tile collapses back into it instead of sliding off. */
export function setBoardReturn(value: boolean): void {
  if (read().boardReturn === value) return;
  write((record) => {
    record.boardReturn = value;
  });
}

/** Drop catalog and camera when the daemon session goes away. */
export function resetBoardCatalog(): void {
  write((record) => {
    record.layouts = [];
    record.workspaceList = [];
    record.tabList = [];
    record.lastLayoutSig = "";
    record.boardWorkspaceId = "";
    record.boardTabId = "";
    record.boardReturn = false;
    record.boardFitted = false;
  });
}

/**
 * One-shot opaque checkpoint of the board catalog fields a snapshot fold writes
 * (camera pan/scale/return are not touched). The caller captures before its own
 * snapshot seed and invokes the closure once, after its assertions, to restore
 * exactly the captured detached values through the owner write; subscriber
 * registration/identity is kept. Never exposes the record or accepts arbitrary
 * state.
 */
export function captureBoardProjection(): () => void {
  const captured = {
    layouts: detach(read().layouts),
    workspaceList: detach(read().workspaceList),
    tabList: detach(read().tabList),
    lastLayoutSig: read().lastLayoutSig,
    boardWorkspaceId: read().boardWorkspaceId,
    boardTabId: read().boardTabId,
    boardFitted: read().boardFitted,
  };
  let used = false;
  return () => {
    if (used) return;
    used = true;
    write((record) => {
      // Owned mutable snapshot: detach already yields a fresh deep plain copy,
      // and the spreads re-derive the exact mutable element types (nested rect
      // and area included) so the values can be handed back to the record
      // without erasing readonly or weakening BoardRecord. Each restored value
      // stays detached plain data with separate identity.
      record.layouts = detach(
        captured.layouts.map((l) => ({ ...l, area: { ...l.area }, panes: l.panes.map((p) => ({ ...p, rect: { ...p.rect } })) })),
      );
      record.workspaceList = detach(captured.workspaceList.map((x) => ({ ...x })));
      record.tabList = detach(captured.tabList.map((x) => ({ ...x })));
      record.lastLayoutSig = captured.lastLayoutSig;
      record.boardWorkspaceId = captured.boardWorkspaceId;
      record.boardTabId = captured.boardTabId;
      record.boardFitted = captured.boardFitted;
    });
  };
}
