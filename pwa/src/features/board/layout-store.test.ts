import { beforeEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { boardStore, projectSnapshot, resetBoardCatalog } from "./layout-store";

const snapshot = (label: string) => ({
  focused: { workspace_id: "w1", tab_id: "t1" },
  workspaces: [{ workspace_id: "w1", label }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1" }],
});

const agents = [{
  paneId: "p1", workspaceId: "w1", tabId: "t1", agent: "", hasAgent: false,
  status: "idle" as const, workspaceLabel: "demo", cwd: "/tmp/demo",
}];

describe("board snapshot projection", () => {
  beforeEach(() => { resetBoardCatalog(); });

  test("a poll that says what the board already says publishes nothing", () => {
    projectSnapshot(snapshot("demo"), agents);
    let publishes = 0;
    const release = boardStore.subscribe(() => { publishes += 1; });
    projectSnapshot(snapshot("demo"), agents);
    projectSnapshot(snapshot("demo"), agents);
    expect(publishes).toBe(0);
    release();
  });

  test("a moved workspace label, tab or layout publishes once", () => {
    projectSnapshot(snapshot("demo"), agents);
    let publishes = 0;
    const release = boardStore.subscribe(() => { publishes += 1; });
    projectSnapshot(snapshot("renamed"), agents);
    expect(publishes).toBe(1);
    expect(boardStore.get().workspaceList).toEqual([{ id: "w1", label: "renamed" }]);
    release();
  });
});
