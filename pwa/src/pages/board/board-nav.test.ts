import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { appRoot } from "../../app/dom-root";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { setPhase, setNetworkOnline } from "../../features/connection/connection-store";
import { currentScreen, leavePaneScreen, setScreen } from "../../app/navigation-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { boardReturn, boardStore, resetBoardCatalog, setBoardCamera, setBoardReturn } from "../../features/board/layout-store";
import { openPaneId, resetPaneView, selectPane } from "../../features/session/session-store";
import { clearNotice } from "../../app/notices-store";
import { releaseBoardScroll } from "./pane-scroll";
import { clearBoardPreviews } from "../../features/board/preview/store";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { setLang } from "../../lib/i18n";

beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); });

async function boot(): Promise<void> {
  setPhase("live");
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  setNetworkOnline(true);
  // Explicit baseline as in the legacy boot: a closed pane, no return path and
  // no in-flight operation are never inherited from a previous case.
  selectPane("");
  setBoardReturn(false);
  setOperationBusy(false);
  resetPaneView();
  setScreen("board");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []);
  attachLiveSession({
    isConnected: () => true,
    createTab: async () => {
      throw new Error("createTab should not run until confirmed");
    },
    paneRead: async (paneId: string) => ({ text: `screen of ${paneId}`, hash: `h-${paneId}` }),
  } as unknown as LiveSession);
  // The legacy boot started from an empty board record so the snapshot fold
  // adopts this seed's focus on every boot, whatever a prior case left behind.
  resetBoardCatalog();
  // The original baseline also reset the camera to identity; resetBoardCatalog
  // does not clear it, and a legit prior zoom must not leak into this boot.
  setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
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
  mountTestApp();
  commitTest();
}

afterEach(async () => {
  // Board previews and session wake-ups resolve after the gesture that asked for
  // them; drain them inside act so the mounted <App/> never re-renders outside a
  // test's act scope.
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    for (let tick = 0; tick < 3; tick += 1) await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  });
  act(() => { releaseBoardScroll(); closeTestDialogs(); clearBoardPreviews(); });
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    clearNotice();
    setOperationBusy(false);
    setScreen("home");
  });
  unmountTestApp();
  appRoot().replaceChildren();
});

describe("board screen", () => {
  test("paints the current tab's pane rectangles", async () => {
    await boot();
    const app = appRoot();
    const panes = [...app.querySelectorAll(".board-pane")];
    expect(panes).toHaveLength(2);
    expect((panes[0] as HTMLElement).style.width).toBe("480px");
    expect((panes[1] as HTMLElement).style.left).toBe("480px");
    expect(app.textContent).toContain("alpha");
    expect(app.textContent).toContain("beta");
    expect(app.querySelector(".board-tab-new")?.textContent).toContain("新建标签页");
    expect(app.querySelectorAll(".board-pane-screen")).toHaveLength(2);
    expect(app.querySelectorAll(".board-pane")[0].getAttribute("data-pane-id")).toBe("w1:p1");
    expect(app.querySelector(".board-zoom .text-link")?.getAttribute("aria-label")).toBe("适配整页布局");
  });

  test("switching workspace is local and does not call the session", async () => {
    await boot();
    const calls: string[] = [];
    act(() => attachLiveSession({
      isConnected: () => true,
      createTab: async () => {
        calls.push("createTab");
        return { pane_id: "x", workspace_id: "w1", tab_id: "x", operation_id: "op_1", outcome: "applied" };
      },
    } as unknown as LiveSession));
    const beta = [...appRoot().querySelectorAll(".board-chip")].find((el) => el.textContent === "beta");
    expect(beta).toBeTruthy();
    act(() => (beta as HTMLButtonElement).click());
    expect(boardStore.get().boardWorkspaceId).toBe("w2");
    expect(boardStore.get().boardTabId).toBe("w2:t1");
    expect(calls).toEqual([]);
    expect(appRoot().querySelectorAll(".board-pane")).toHaveLength(1);
    expect(appRoot().textContent).toContain("beta-one");
  });

  /** One tap opens: no double-tap window to wait out, so the board never feels stuck. */
  test("tapping a pane opens the session, not a dialog", async () => {
    await boot();
    const pane = appRoot().querySelector(".board-pane") as HTMLButtonElement;
    // openPane runs session awaits before it settles; the original fixture
    // drained exactly four zero-delay timers inside act and was green/0-warning
    // on the real App — no rAF, no wider drain.
    await act(async () => {
      pane.click();
      for (let tick = 0; tick < 4; tick += 1) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(currentScreen()).toBe("pane");
    expect(boardReturn()).toBe(true);
    expect(openPaneId()).toBe("w1:p1");
  });

  /** The second tap is a camera move, so it no longer competes with opening. */
  test("double-clicking a pane zooms the canvas instead of opening again", async () => {
    await boot();
    const before = boardStore.get().boardScale;
    const pane = appRoot().querySelector(".board-pane") as HTMLButtonElement;
    act(() => pane.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(document.querySelector("dialog")).toBeNull();
    expect(currentScreen()).toBe("board");
    expect(boardStore.get().boardScale).not.toBe(before);
  });

  test("back from a pane opened on the board returns to the board", async () => {
    await boot();
    act(() => {
      setScreen("pane");
      setBoardReturn(true);
      leavePaneScreen();
    });
    expect(currentScreen()).toBe("board");
    expect(boardReturn()).toBe(false);
    // leavePaneScreen schedules a requestCommit -> composeTransaction -> setScreen
    // commit publication as a microtask; wrap it asynchronously so the App never
    // commits outside this act boundary.
    await act(async () => { leavePaneScreen(); });
    expect(currentScreen()).toBe("home");
  });

  test("duplicate workspace chips keep a folder tail", async () => {
    await boot();
    act(() => replaceAgentsFromSnapshot({
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
    }));
    commitTest();
    const chips = [...appRoot().querySelectorAll(".board-chip")].map((el) => el.textContent);
    expect(chips).toContain("pairfob · test/pairfob");
    expect(chips).toContain("pairfob · github/pairfob");
    expect([...appRoot().querySelectorAll(".board-tab")].map((el) => el.textContent)).toContain("第 1 页");
  });

  test("a 1:1:2 tab paints the double pane at twice the cell width", async () => {
    await boot();
    act(() => replaceAgentsFromSnapshot({
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
    }));
    commitTest();
    const panes = [...appRoot().querySelectorAll<HTMLElement>(".board-pane")];
    expect(panes.map((el) => el.style.width)).toEqual(["424px", "432px", "848px"]);
    expect(panes[2].style.left).toBe("856px");
    expect((appRoot().querySelector(".board-stage") as HTMLElement).style.width).toBe("1704px");
  });

  test("new tab stays on the board after the capability button is shown", async () => {
    await boot();
    expect(currentScreen()).toBe("board");
    expect(appRoot().querySelector(".board-tab-new")).toBeInstanceOf(HTMLButtonElement);
    const tabs = [...appRoot().querySelectorAll(".board-tab")].map((el) => el.textContent);
    expect(tabs.some((label) => label?.includes("logs"))).toBe(true);
  });
});