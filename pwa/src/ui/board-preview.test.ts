import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "Node",
  "DocumentFragment",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
happy.document.body.innerHTML = '<main id="app"><div class="board-pane" data-pane-id="w1:p1"><span class="board-pane-screen"></span></div><div class="board-pane" data-pane-id="w1:p2"><span class="board-pane-screen"></span></div></main>';

const { state } = await import("../state.ts");
const {
  BOARD_PREVIEW_MAX_PANES,
  boardPreviewPaneIds,
  boardPreviewText,
  clearBoardPreviews,
  fillAnsiPreview,
  previewFillScale,
  previewGridPx,
  previewLineCount,
  refreshBoardPreviews,
} = await import("./board-preview.ts");

afterEach(() => {
  clearBoardPreviews();
  state.live = null;
  state.screen = "home";
  state.agents = [];
  state.layouts = [];
  state.boardTabId = "";
  state.networkOnline = true;
  for (const host of document.querySelectorAll(".board-pane-screen")) host.replaceChildren();
});

describe("board pane previews", () => {
  test("paints ANSI color into a compact screen, not a live xterm", () => {
    const host = document.createElement("div");
    fillAnsiPreview(host, "\x1b[38;2;225;0;0mred\x1b[0m plain");
    expect(host.querySelector(".board-pane-buffer")).toBeTruthy();
    expect(host.querySelector(".board-pane-line")?.textContent).toContain("red");
    expect(host.innerHTML).toContain("rgb(225, 0, 0)");
  });

  test("fits the TUI grid into the cell without stretching either axis", () => {
    expect(previewFillScale(480, 640, 520, 660)).toEqual({ x: 660 / 640, y: 660 / 640 });
    expect(previewFillScale(8, 16, 400, 640)).toEqual({ x: 1, y: 1 });
    expect(previewGridPx(52, 40)).toEqual({ width: 416, height: 640 });
  });

  test("keeps the computer's trailing pad so the preview can fill the cell", () => {
    const host = document.createElement("div");
    fillAnsiPreview(host, "ok" + " ".repeat(12));
    expect(host.querySelector(".board-pane-line")?.textContent).toBe("ok" + " ".repeat(12));
  });

  test("paints a layout-sized grid even when the dump is short", () => {
    const host = document.createElement("div");
    fillAnsiPreview(host, "ok", 50, 24);
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

    expect(boardPreviewPaneIds(state.layouts[0])[0]).toBe("w1:p2");
    await refreshBoardPreviews();
    expect(order).toEqual(["w1:p2", "w1:p1"]);
    expect(boardPreviewText("w1:p2")).toBe("screen w1:p2");
    expect(document.querySelector('[data-pane-id="w1:p2"] .board-pane-screen')?.textContent).toContain("screen w1:p2");

    await refreshBoardPreviews();
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
