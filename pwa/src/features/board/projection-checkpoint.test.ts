import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { boardReturn, captureBoardProjection, boardStore, liveBoardCamera, resetBoardCatalog, setBoardCamera, setBoardReturn } from "./layout-store";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";

const seedRestorer = new WorkspaceSnapshotRestorer();
let previousCamera: ReturnType<typeof liveBoardCamera>;
let previousReturn: boolean;
await resetTestDOM();

function snap(ws: string, label: string) {
  return {
    focused: { workspace_id: ws, tab_id: `${ws}:t1`, pane_id: `${ws}:p1` },
    workspaces: [{ workspace_id: ws, label }],
    tabs: [{ tab_id: `${ws}:t1`, workspace_id: ws, label: "main" }],
    panes: [{ pane_id: `${ws}:p1`, workspace_id: ws, tab_id: `${ws}:t1`, cwd: `/work/${ws}`, agent_status: "idle" }],
  };
}

beforeEach(() => {
  previousCamera = liveBoardCamera();
  previousReturn = boardReturn();
  seedRestorer.capture();
  resetBoardCatalog();
});
afterEach(() => {
  resetBoardCatalog();
  setBoardCamera(previousCamera, previousCamera.fitted);
  setBoardReturn(previousReturn);
  seedRestorer.restore();
});

describe("captureBoardProjection restores the snapshot-affected catalog fields", () => {
  test("rolls the board catalog back to its pre-seed projection", () => {
    replaceAgentsFromSnapshot(snap("w1", "alpha"));
    const restore = captureBoardProjection();
    replaceAgentsFromSnapshot(snap("w2", "renamed"));
    expect(boardStore.get().workspaceList[0]?.label).toBe("renamed");
    expect(boardStore.get().boardWorkspaceId).toBe("w2");
    restore();
    expect(boardStore.get().workspaceList[0]?.label).toBe("alpha");
    expect(boardStore.get().boardWorkspaceId).toBe("w1");
    expect(boardStore.get().boardTabId).toBe("w1:t1");
  });

  test("restores to the pre-seed empty catalog baseline", () => {
    const restore = captureBoardProjection();
    replaceAgentsFromSnapshot(snap("w1", "alpha"));
    expect(boardStore.get().workspaceList.length).toBeGreaterThan(0);
    restore();
    expect(boardStore.get().workspaceList).toEqual([]);
    expect(boardStore.get().layouts).toEqual([]);
  });

  test("is one-shot and does not touch camera pan/scale/return fields", () => {
    replaceAgentsFromSnapshot(snap("w1", "alpha"));
    setBoardCamera({ scale: 2, panX: 7, panY: 9 }, false);
    const restore = captureBoardProjection();
    replaceAgentsFromSnapshot(snap("w2", "beta"));
    restore();
    expect(boardStore.get().boardWorkspaceId).toBe("w1");
    expect(boardStore.get().boardScale).toBe(2);
    expect(boardStore.get().boardPanX).toBe(7);
    restore();
    expect(boardStore.get().boardWorkspaceId).toBe("w1");
  });
});
