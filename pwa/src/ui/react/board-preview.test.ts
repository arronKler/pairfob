import { resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { app, replaceAgentsFromSnapshot, state } from "../../state";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { boardPreviewSnapshot, clearBoardPreviews, refreshBoardPanePreview, refreshBoardPreviews } from "../board-preview";
import { BoardScreen } from "./board";
import { act } from "react";
import { paintBoard, renderReact, unmountReact } from "../../../test-support/react-harness";

beforeEach(resetBoardTestDOM);

function bootBoard(): void {
  state.phase = "live";
  state.screen = "board";
  state.networkOnline = true;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [{ workspace_id: "w1", label: "alpha" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
    ],
    layouts: [
      {
        workspace_id: "w1",
        tab_id: "w1:t1",
        zoomed: false,
        focused_pane_id: "w1:p1",
        area: { x: 0, y: 0, width: 80, height: 24 },
        panes: [{ pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } }],
      },
    ],
  });
  state.live = {
    isConnected: () => true,
    paneRead: async (paneId: string) => ({ text: `\x1b[31m${paneId}\x1b[0m`, hash: `h-${paneId}` }),
  } as typeof state.live;
  paintBoard();
}

afterEach(() => {
  act(clearBoardPreviews);
  state.live = null;
  state.screen = "home";
  unmountReact();
  app.replaceChildren();
});

describe("react board previews", () => {
  test("reads update React ANSI without replacing the tile node", async () => {
    bootBoard();
    const tile = app.querySelector(".board-pane");
    const stage = app.querySelector(".board-stage");
    expect(tile).toBeTruthy();
    await act(async () => {
      await refreshBoardPreviews();
    });
    renderReact(createElement(BoardScreen));
    expect(app.querySelector(".board-pane") === tile).toBeTrue();
    expect(app.querySelector(".board-stage") === stage).toBeTrue();
    expect(tile?.querySelector(".board-pane-screen")?.textContent).toContain("w1:p1");
    expect(tile?.querySelector(".board-pane-line")).toBeTruthy();
  });

  test("unchanged poll and direct refresh retain the subscribed buffer and cached snapshot", async () => {
    bootBoard();
    await act(refreshBoardPreviews);
    const screen = app.querySelector(".board-pane-screen") as HTMLElement;
    const buffer = screen.querySelector(".board-pane-buffer");
    const snapshot = boardPreviewSnapshot("w1:p1");
    expect(buffer).toBeTruthy();
    await act(refreshBoardPreviews);
    expect(screen.querySelector(".board-pane-buffer") === buffer).toBeTrue();
    expect(boardPreviewSnapshot("w1:p1") === snapshot).toBeTrue();
    await act(() => refreshBoardPanePreview("w1:p1"));
    expect(screen.querySelector(".board-pane-buffer") === buffer).toBeTrue();
    expect(boardPreviewSnapshot("w1:p1") === snapshot).toBeTrue();
    expect(screen.textContent).toContain("w1:p1");
  });
});
