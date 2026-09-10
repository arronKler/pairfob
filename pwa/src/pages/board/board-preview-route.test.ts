import { resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { appRoot } from "../../app/dom-root";
import { setPhase, setNetworkOnline } from "../../features/connection/connection-store";
import { setScreen } from "../../app/navigation-store";
import { applyCapabilities } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { resetBoardCatalog } from "../../features/board/layout-store";
import { boardPreviewSnapshot, clearBoardPreviews } from "../../features/board/preview/store";
import { refreshBoardPanePreview, refreshBoardPreviews } from "../../features/board/preview/refresh";
import { appMounted, commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";

const AGENT_KINDS = ["codex", "claude", "grok", "pi"];

beforeEach(async () => {
  await resetBoardTestDOM();
});

function bootBoard(): void {
  setPhase("live");
  setScreen("board");
  setNetworkOnline(true);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, AGENT_KINDS);
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
  attachLiveSession({
    isConnected: () => true,
    paneRead: async (paneId: string) => ({ text: `\x1b[31m${paneId}\x1b[0m`, hash: `h-${paneId}` }),
  } as unknown as LiveSession);
  mountTestApp();
  commitTest();
}

afterEach(async () => {
  await act(async () => {
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  act(clearBoardPreviews);
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    setScreen("home");
  });
  unmountTestApp();
  appRoot().replaceChildren();
});

describe("react board previews", () => {
  test("reads update React ANSI without replacing the tile node", async () => {
    bootBoard();
    expect(appMounted()).toBeTrue();
    const app = appRoot();
    const tile = app.querySelector(".board-pane");
    const stage = app.querySelector(".board-stage");
    expect(tile).toBeTruthy();
    await act(async () => {
      await refreshBoardPreviews();
    });
    commitTest();
    expect(app.querySelector(".board-pane") === tile).toBeTrue();
    expect(app.querySelector(".board-stage") === stage).toBeTrue();
    expect(tile?.querySelector(".board-pane-screen")?.textContent).toContain("w1:p1");
    expect(tile?.querySelector(".board-pane-line")).toBeTruthy();
  });

  test("unchanged poll and direct refresh retain the subscribed buffer and cached snapshot", async () => {
    bootBoard();
    await act(refreshBoardPreviews);
    const app = appRoot();
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
