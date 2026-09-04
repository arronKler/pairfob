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
  "HTMLDialogElement",
  "MouseEvent",
  "PointerEvent",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.history = happy.history;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, leavePaneScreen, replaceAgentsFromSnapshot, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderBoard } = await import("./board.ts");
const { releaseBoardScroll } = await import("./board-canvas.ts");
const { clearBoardPreviews } = await import("./board-preview.ts");
const { BOARD_DOUBLE_TAP_MS } = await import("./board-gesture.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../lib/operations.ts");

function boot(): void {
  state.phase = "live";
  state.screen = "board";
  state.operationBusy = false;
  state.runtimeKind = "herdr";
  state.networkOnline = true;
  state.paneId = "";
  state.boardReturn = false;
  state.boardWorkspaceId = "";
  state.boardTabId = "";
  state.boardFitted = true;
  state.boardScale = 1;
  state.boardPanX = 0;
  state.boardPanY = 0;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, create_tab: true };
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [
      { workspace_id: "w1", label: "alpha" },
      { workspace_id: "w2", label: "beta" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "logs" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "review" },
    ],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "codex", agent_status: "working", label: "two" },
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "logs" },
      { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", cwd: "/tmp/b", agent: "grok", agent_status: "blocked", label: "beta-one" },
    ],
    layouts: [
      {
        workspace_id: "w1",
        tab_id: "w1:t1",
        zoomed: false,
        focused_pane_id: "w1:p1",
        area: { x: 0, y: 0, width: 100, height: 40 },
        panes: [
          { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
          { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
        ],
      },
    ],
  });
  state.live = {
    isConnected: () => true,
    createTab: async () => {
      throw new Error("createTab should not run until confirmed");
    },
    paneRead: async (paneId: string) => ({ text: `screen of ${paneId}`, hash: `h-${paneId}` }),
  } as typeof state.live;
  setRenderer(() => renderBoard());
  renderBoard();
}

afterEach(() => {
  releaseBoardScroll();
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  clearBoardPreviews();
  state.live = null;
  state.agents = [];
  state.layouts = [];
  state.workspaceList = [];
  state.tabList = [];
  state.boardWorkspaceId = "";
  state.boardTabId = "";
  state.notice = null;
  app.replaceChildren();
});

describe("board screen", () => {
  test("paints the current tab's pane rectangles", () => {
    boot();
    const panes = [...app.querySelectorAll(".board-pane")];
    expect(panes).toHaveLength(2);
    expect(panes[0].style.width).toBe("60%");
    expect(panes[1].style.left).toBe("60%");
    expect(app.textContent).toContain("alpha");
    expect(app.textContent).toContain("beta");
    expect(app.querySelector(".board-tab-new")?.textContent).toContain("新建标签页");
    expect(app.querySelectorAll(".board-pane-screen")).toHaveLength(2);
    expect(app.querySelectorAll(".board-pane")[0].getAttribute("data-pane-id")).toBe("w1:p1");
    expect(app.querySelector(".board-zoom .text-link")?.getAttribute("aria-label")).toBe("适配整页布局");
  });

  test("switching workspace is local and does not call the session", () => {
    boot();
    const calls: string[] = [];
    state.live = {
      isConnected: () => true,
      createTab: async () => {
        calls.push("createTab");
        return { pane_id: "x", workspace_id: "w1", tab_id: "x", operation_id: "op_1", outcome: "applied" };
      },
    } as typeof state.live;
    const beta = [...app.querySelectorAll(".board-chip")].find((el) => el.textContent === "beta");
    expect(beta).toBeTruthy();
    (beta as HTMLButtonElement).click();
    expect(state.boardWorkspaceId).toBe("w2");
    expect(state.boardTabId).toBe("w2:t1");
    expect(calls).toEqual([]);
    expect(app.querySelectorAll(".board-pane")).toHaveLength(1);
    expect(app.textContent).toContain("beta-one");
  });

  test("tapping a pane opens the session, not a dialog", async () => {
    boot();
    const pane = app.querySelector(".board-pane") as HTMLButtonElement;
    pane.click();
    expect(document.querySelector("dialog")).toBeNull();
    expect(state.screen).toBe("board");
    await new Promise((resolve) => setTimeout(resolve, BOARD_DOUBLE_TAP_MS + 30));
    expect(state.screen).toBe("pane");
    expect(state.boardReturn).toBe(true);
    expect(state.paneId).toBe("w1:p1");
  });

  test("double-clicking a pane opens the session immediately", () => {
    boot();
    const pane = app.querySelector(".board-pane") as HTMLButtonElement;
    pane.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.querySelector("dialog")).toBeNull();
    expect(state.screen).toBe("pane");
    expect(state.boardReturn).toBe(true);
    expect(state.paneId).toBe("w1:p1");
  });

  test("back from a pane opened on the board returns to the board", () => {
    boot();
    state.screen = "pane";
    state.boardReturn = true;
    leavePaneScreen();
    expect(state.screen).toBe("board");
    expect(state.boardReturn).toBe(false);
    leavePaneScreen();
    expect(state.screen).toBe("home");
  });

  test("duplicate workspace chips keep a folder tail", () => {
    boot();
    replaceAgentsFromSnapshot({
      workspaces: [
        { workspace_id: "w1", label: "pairfob" },
        { workspace_id: "w2", label: "pairfob" },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "1" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "main" },
      ],
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/test/pairfob", agent: "", agent_status: "idle" },
        { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", cwd: "/tmp/github/pairfob", agent: "", agent_status: "idle" },
      ],
    });
    renderBoard();
    const chips = [...app.querySelectorAll(".board-chip")].map((el) => el.textContent);
    expect(chips).toContain("pairfob · test/pairfob");
    expect(chips).toContain("pairfob · github/pairfob");
    expect([...app.querySelectorAll(".board-tab")].map((el) => el.textContent)).toContain("第 1 页");
  });

  test("new tab stays on the board after the capability button is shown", () => {
    boot();
    expect(state.screen).toBe("board");
    expect(app.querySelector(".board-tab-new")).toBeInstanceOf(HTMLButtonElement);
    const tabs = [...app.querySelectorAll(".board-tab")].map((el) => el.textContent);
    expect(tabs.some((label) => label?.includes("logs"))).toBe(true);
  });
});
