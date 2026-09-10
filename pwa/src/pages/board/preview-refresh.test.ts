import { resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { BoardAnsiPreview } from "../../features/board/components/board-preview";
import { boardPreviewPaneIds } from "../../features/board/preview/model";
import { boardPreviewText, clearBoardPreviews } from "../../features/board/preview/store";
import { boardStore, resetBoardCatalog } from "../../features/board/layout-store";
import { setScreen } from "../../app/navigation-store";
import { setNetworkOnline } from "../../features/connection/connection-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import { refreshBoardPreviews } from "../../features/board/preview/refresh";

beforeEach(resetBoardTestDOM);

afterEach(() => {
  act(() => { unmountReact(); clearBoardPreviews(); });
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    setScreen("home");
    setNetworkOnline(true);
  });
});

/** Render one pane's preview tile as a deliberate component fixture. */
function showPreviews(paneIds: string[], cols = 0, rows = 0): void {
  renderReact(createElement("div", {}, paneIds.map(paneId => createElement("div", {
    key: paneId, className: "board-pane", "data-pane-id": paneId,
  }, createElement(BoardAnsiPreview, { paneId, cols, rows })))));
}

function seedSinglePane(text: string): void {
  attachLiveSession({ isConnected: () => true, paneRead: async () => ({ text, hash: text }) } as unknown as LiveSession);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [{ workspace_id: "w1", label: "alpha" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp", agent: "codex", agent_status: "idle" },
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
  setScreen("board");
  setNetworkOnline(true);
}

async function paintPreview(text: string, cols = 0, rows = 0): Promise<HTMLElement> {
  seedSinglePane(text);
  showPreviews(["w1:p1"], cols, rows);
  await act(refreshBoardPreviews);
  return appRoot().querySelector<HTMLElement>(".board-pane-screen")!;
}

describe("board pane previews", () => {
  test("paints ANSI color into a compact React screen, not a live xterm", async () => {
    const host = await paintPreview("\x1b[38;2;225;0;0mred\x1b[0m plain");
    expect(host.querySelector(".board-pane-buffer")).toBeTruthy();
    expect(host.querySelector(".board-pane-line")?.textContent).toContain("red");
    expect(host.innerHTML).toContain("rgb(225, 0, 0)");
  });

  test("keeps the computer's trailing pad so the preview can fill the cell", async () => {
    const host = await paintPreview("ok" + " ".repeat(12));
    expect(host.querySelector(".board-pane-line")?.textContent).toBe("ok" + " ".repeat(12));
  });

  test("paints a layout-sized grid even when the dump is short", async () => {
    const host = await paintPreview("ok", 50, 24);
    const inner = host.querySelector(".board-pane-buffer") as HTMLElement;
    expect(inner.style.width).toBe("400px");
    expect(inner.style.height).toBe("384px");
    expect(host.querySelectorAll(".board-pane-line")).toHaveLength(24);
  });

  test("reads the current tab serially, skips an unchanged hash, and caps the fan-out", async () => {
    const order: string[] = [];
    let calls = 0;
    attachLiveSession({
      isConnected: () => true,
      paneRead: async (paneId: string) => {
        calls += 1;
        order.push(paneId);
        return { text: `screen ${paneId}`, hash: `h-${paneId}` };
      },
    } as unknown as LiveSession);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2" },
      workspaces: [{ workspace_id: "w1", label: "alpha" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp", agent: "claude", agent_status: "idle" },
        { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp", agent: "codex", agent_status: "working" },
      ],
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "w1:t1",
          zoomed: false,
          focused_pane_id: "w1:p2",
          area: { x: 0, y: 0, width: 100, height: 40 },
          panes: [
            { pane_id: "w1:p1", focused: false, rect: { x: 0, y: 0, width: 50, height: 40 } },
            { pane_id: "w1:p2", focused: true, rect: { x: 50, y: 0, width: 50, height: 40 } },
          ],
        },
      ],
    });
    setScreen("board");
    setNetworkOnline(true);

    showPreviews(["w1:p1", "w1:p2"]);
    expect(boardPreviewPaneIds(boardStore.get().layouts[0])[0]).toBe("w1:p2");
    await act(refreshBoardPreviews);
    expect(order).toEqual(["w1:p2", "w1:p1"]);
    expect(boardPreviewText("w1:p2")).toBe("screen w1:p2");
    expect(document.querySelector('[data-pane-id="w1:p2"] .board-pane-screen')?.textContent).toContain("screen w1:p2");

    await act(refreshBoardPreviews);
    expect(calls).toBe(4);
    expect(document.querySelector('[data-pane-id="w1:p1"] .board-pane-screen')?.textContent).toContain("screen w1:p1");
  });

  test("a hidden document, an offline network or another screen reads nothing", async () => {
    seedSinglePane("x");
    let reads = 0;
    attachLiveSession({
      isConnected: () => true,
      paneRead: async () => {
        reads += 1;
        return { text: "x", hash: "x" };
      },
    } as unknown as LiveSession);

    setNetworkOnline(false);
    await act(refreshBoardPreviews);
    expect(reads).toBe(0);

    setNetworkOnline(true);
    setScreen("home");
    await act(refreshBoardPreviews);
    expect(reads).toBe(0);

    setScreen("board");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(refreshBoardPreviews);
    expect(reads).toBe(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    attachLiveSession({ isConnected: () => false, paneRead: async () => { reads += 1; return { text: "x", hash: "x" }; } } as unknown as LiveSession);
    await act(refreshBoardPreviews);
    expect(reads).toBe(0);
  });
});