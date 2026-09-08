import { closeTestDialogs } from "../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";

const { app, leavePaneScreen, replaceAgentsFromSnapshot, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderApp } = await import("./react/app-screen");
const { leaveReactScreen } = await import("./react/root");
const { setLang } = await import("../lib/i18n");

beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); });
const { releaseBoardScroll } = await import("./board-canvas.ts");
const { clearBoardPreviews } = await import("./board-preview.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../lib/operations.ts");

function boot(): void {
  state.phase = "live";
  state.screen = "board";
  state.fullTerminal = false;
  state.agentChat = false;
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
  setRenderer(renderApp);
  act(renderApp);
}

afterEach(() => {
  act(() => { releaseBoardScroll(); closeTestDialogs(); leaveReactScreen(); clearBoardPreviews(); });
  setRenderer(() => {});
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
    expect(panes[0].style.width).toBe("480px");
    expect(panes[1].style.left).toBe("480px");
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
    act(() => (beta as HTMLButtonElement).click());
    expect(state.boardWorkspaceId).toBe("w2");
    expect(state.boardTabId).toBe("w2:t1");
    expect(calls).toEqual([]);
    expect(app.querySelectorAll(".board-pane")).toHaveLength(1);
    expect(app.textContent).toContain("beta-one");
  });

  /** One tap opens: no double-tap window to wait out, so the board never feels stuck. */
  test("tapping a pane opens the session, not a dialog", async () => {
    boot();
    const pane = app.querySelector(".board-pane") as HTMLButtonElement;
    await act(async () => { pane.click(); await Promise.resolve(); });
    expect(document.querySelector("dialog")).toBeNull();
    expect(state.screen).toBe("pane");
    expect(state.boardReturn).toBe(true);
    expect(state.paneId).toBe("w1:p1");
  });

  /** The second tap is a camera move, so it no longer competes with opening. */
  test("double-clicking a pane zooms the canvas instead of opening again", () => {
    boot();
    const before = state.boardScale;
    const pane = app.querySelector(".board-pane") as HTMLButtonElement;
    act(() => pane.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(document.querySelector("dialog")).toBeNull();
    expect(state.screen).toBe("board");
    expect(state.boardScale).not.toBe(before);
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
    act(renderApp);
    const chips = [...app.querySelectorAll(".board-chip")].map((el) => el.textContent);
    expect(chips).toContain("pairfob · test/pairfob");
    expect(chips).toContain("pairfob · github/pairfob");
    expect([...app.querySelectorAll(".board-tab")].map((el) => el.textContent)).toContain("第 1 页");
  });

  test("a 1:1:2 tab paints the double pane at twice the cell width", () => {
    boot();
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p5" },
      workspaces: [{ workspace_id: "w1", label: "alpha" }],
      tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "split" }],
      panes: [
        { pane_id: "w1:p4", workspace_id: "w1", tab_id: "w1:t2", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "a" },
        { pane_id: "w1:pJ", workspace_id: "w1", tab_id: "w1:t2", cwd: "/tmp/a", agent: "codex", agent_status: "idle", label: "b" },
        { pane_id: "w1:p5", workspace_id: "w1", tab_id: "w1:t2", cwd: "/tmp/a", agent: "grok", agent_status: "working", label: "c" },
      ],
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "w1:t2",
          zoomed: false,
          focused_pane_id: "w1:p5",
          area: { x: 26, y: 1, width: 213, height: 60 },
          panes: [
            { pane_id: "w1:p4", focused: false, rect: { x: 26, y: 1, width: 53, height: 60 } },
            { pane_id: "w1:pJ", focused: false, rect: { x: 79, y: 1, width: 54, height: 60 } },
            { pane_id: "w1:p5", focused: true, rect: { x: 133, y: 1, width: 106, height: 60 } },
          ],
        },
      ],
    });
    act(renderApp);
    const panes = [...app.querySelectorAll<HTMLElement>(".board-pane")];
    expect(panes.map((el) => el.style.width)).toEqual(["424px", "432px", "848px"]);
    expect(panes[2].style.left).toBe("856px");
    expect((app.querySelector(".board-stage") as HTMLElement).style.width).toBe("1704px");
  });

  test("new tab stays on the board after the capability button is shown", () => {
    boot();
    expect(state.screen).toBe("board");
    expect(app.querySelector(".board-tab-new")).toBeInstanceOf(HTMLButtonElement);
    const tabs = [...app.querySelectorAll(".board-tab")].map((el) => el.textContent);
    expect(tabs.some((label) => label?.includes("logs"))).toBe(true);
  });
});
