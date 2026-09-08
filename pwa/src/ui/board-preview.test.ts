import { resetBoardTestDOM } from "../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";

const { app, state } = await import("../state.ts");
const {
  BOARD_PREVIEW_MAX_PANES,
  boardPreviewPaneIds,
  boardPreviewText,
  clearBoardPreviews,
  previewFillScale,
  previewGridPx,
  previewLineCount,
  refreshBoardPreviews,
} = await import("./board-preview.ts");

const { BoardAnsiPreview } = await import("./react/board-preview");
const { leaveReactScreen, renderReactScreen } = await import("./react/root");

beforeEach(resetBoardTestDOM);
afterEach(() => {
  act(() => { leaveReactScreen(); clearBoardPreviews(); });
  state.live = null;
  state.screen = "home";
  state.agents = [];
  state.layouts = [];
  state.boardTabId = "";
  state.networkOnline = true;
});

function showPreviews(paneIds: string[], cols = 0, rows = 0): void {
  act(() => renderReactScreen(createElement("div", {}, paneIds.map(paneId => createElement("div", {
    key: paneId, className: "board-pane", "data-pane-id": paneId,
  }, createElement(BoardAnsiPreview, { paneId, cols, rows }))))));
}

async function paintPreview(text: string, cols = 0, rows = 0): Promise<HTMLElement> {
  state.screen = "board";
  state.networkOnline = true;
  state.boardTabId = "w1:t1";
  state.agents = [{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", agent: "codex", status: "idle", workspaceLabel: "a", cwd: "/tmp" }];
  state.layouts = [{ workspaceId: "w1", tabId: "w1:t1", zoomed: false, focusedPaneId: "w1:p1",
    area: { x: 0, y: 0, width: 80, height: 24 },
    panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 80, height: 24 } }] }];
  state.live = { isConnected: () => true, paneRead: async () => ({ text, hash: text }) } as typeof state.live;
  showPreviews(["w1:p1"], cols, rows);
  await act(refreshBoardPreviews);
  return app.querySelector<HTMLElement>(".board-pane-screen")!;
}

describe("board pane previews", () => {
  test("paints ANSI color into a compact React screen, not a live xterm", async () => {
    const host = await paintPreview("\x1b[38;2;225;0;0mred\x1b[0m plain");
    expect(host.querySelector(".board-pane-buffer")).toBeTruthy();
    expect(host.querySelector(".board-pane-line")?.textContent).toContain("red");
    expect(host.innerHTML).toContain("rgb(225, 0, 0)");
  });

  test("fits the TUI grid into the cell without stretching either axis", () => {
    expect(previewFillScale(480, 640, 520, 660)).toEqual({ x: 660 / 640, y: 660 / 640 });
    expect(previewFillScale(8, 16, 400, 640)).toEqual({ x: 1, y: 1 });
    expect(previewGridPx(52, 40)).toEqual({ width: 416, height: 640 });
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
    state.screen = "board";
    state.boardTabId = "w1:t1";
    state.networkOnline = true;
    state.agents = [
      { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", agent: "claude", status: "idle", workspaceLabel: "a", cwd: "/tmp" },
      { paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1", agent: "codex", status: "working", workspaceLabel: "a", cwd: "/tmp" },
    ];
    state.layouts = [
      {
        workspaceId: "w1",
        tabId: "w1:t1",
        zoomed: false,
        focusedPaneId: "w1:p2",
        area: { x: 0, y: 0, width: 100, height: 40 },
        panes: [
          { paneId: "w1:p1", focused: false, rect: { x: 0, y: 0, width: 50, height: 40 } },
          { paneId: "w1:p2", focused: true, rect: { x: 50, y: 0, width: 50, height: 40 } },
        ],
      },
    ];
    state.live = {
      isConnected: () => true,
      paneRead: async (paneId: string) => {
        calls += 1;
        order.push(paneId);
        return { text: `screen ${paneId}`, hash: `h-${paneId}` };
      },
    } as typeof state.live;

    showPreviews(["w1:p1", "w1:p2"]);
    expect(boardPreviewPaneIds(state.layouts[0])[0]).toBe("w1:p2");
    await act(refreshBoardPreviews);
    expect(order).toEqual(["w1:p2", "w1:p1"]);
    expect(boardPreviewText("w1:p2")).toBe("screen w1:p2");
    expect(document.querySelector('[data-pane-id="w1:p2"] .board-pane-screen')?.textContent).toContain("screen w1:p2");

    await act(refreshBoardPreviews);
    expect(calls).toBe(4);
    expect(document.querySelector('[data-pane-id="w1:p1"] .board-pane-screen')?.textContent).toContain("screen w1:p1");
  });

  test("line count follows the pane viewport and the id cap stays at eight", () => {
    expect(previewLineCount(48, 20)).toBe(48);
    expect(previewLineCount(undefined, 12)).toBe(12);
    expect(previewLineCount()).toBe(24);
    const ids = boardPreviewPaneIds({
      workspaceId: "w1",
      tabId: "w1:t1",
      zoomed: false,
      focusedPaneId: "p9",
      area: { x: 0, y: 0, width: 10, height: 10 },
      panes: Array.from({ length: 12 }, (_, index) => ({
        paneId: `p${index + 1}`,
        focused: index === 8,
        rect: { x: 0, y: 0, width: 1, height: 10 },
      })),
    });
    expect(ids).toHaveLength(BOARD_PREVIEW_MAX_PANES);
    expect(ids[0]).toBe("p9");
    expect(ids).not.toContain("p12");
  });
});
