import { describe, expect, test } from "bun:test";
import { applyBoardSnapshot, initialBoardViewState } from "./state-board";

describe("board state projection", () => {
  test("starts with an unfitted neutral camera", () => {
    expect(initialBoardViewState()).toEqual({
      layouts: [], workspaceList: [], tabList: [], lastLayoutSig: "",
      boardWorkspaceId: "", boardTabId: "", boardScale: 1,
      boardPanX: 0, boardPanY: 0, boardFitted: false, boardReturn: false,
    });
  });

  test("updates catalog and invalidates a fitted camera when focus changes", () => {
    const state = initialBoardViewState();
    state.boardFitted = true;
    applyBoardSnapshot(state, {
      focused: { workspace_id: "w1", tab_id: "t1" },
      workspaces: [{ workspace_id: "w1", label: "demo" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1" }],
    }, [{
      paneId: "p1", workspaceId: "w1", tabId: "t1", agent: "", hasAgent: false,
      status: "idle", workspaceLabel: "demo", cwd: "/tmp/demo",
    }]);

    expect(state.workspaceList).toEqual([{ id: "w1", label: "demo" }]);
    expect(state.tabList).toEqual([{ id: "t1", workspaceId: "w1", label: "main" }]);
    expect([state.boardWorkspaceId, state.boardTabId, state.boardFitted]).toEqual(["w1", "t1", false]);
  });
});
