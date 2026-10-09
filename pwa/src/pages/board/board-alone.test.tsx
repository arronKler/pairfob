import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appRoot } from "../../app/dom-root";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearNotice } from "../../app/notices-store";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { setLang, t } from "../../lib/i18n";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { boardReturn, resetBoardCatalog, setBoardCamera, setBoardReturn } from "../../features/board/layout-store";
import { clearBoardPreviews } from "../../features/board/preview/store";
import { openPaneId, resetPaneView, selectPane } from "../../features/session/session-store";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { releaseBoardScroll } from "./pane-scroll";

/**
 * The board in the desk's narrowest tier (720–899px), against the mounted App:
 * the list gives the board its column, and the board's header leads back to
 * the list and to the session the list stood beside.
 */

/** Session awaits and board previews settle after the gesture that asked for them. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 4; tick += 1) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

async function boot(width: number, paneId = ""): Promise<HTMLElement> {
  happy.happyDOM.setWindowSize({ width, height: 1180 });
  setPhase("live");
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  setNetworkOnline(true);
  selectPane(paneId);
  setBoardReturn(false);
  setOperationBusy(false);
  resetPaneView();
  setScreen("board");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  attachLiveSession({
    isConnected: () => true,
    paneRead: async (id: string) => ({ text: `screen of ${id}`, hash: `h-${id}` }),
  } as unknown as LiveSession);
  resetBoardCatalog();
  setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [{ workspace_id: "w1", label: "alpha" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "codex", agent_status: "blocked", label: "two" },
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "grok", agent_status: "blocked", label: "three" },
    ],
    layouts: [{
      workspace_id: "w1",
      tab_id: "w1:t1",
      zoomed: false,
      focused_pane_id: "w1:p1",
      area: { x: 0, y: 0, width: 100, height: 40 },
      panes: [
        { pane_id: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
        { pane_id: "w1:p2", focused: false, rect: { x: 60, y: 0, width: 40, height: 40 } },
      ],
    }],
  } as never);
  mountTestApp();
  commitTest();
  await settle();
  return appRoot();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(async () => {
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
    selectPane("");
    setScreen("home");
  });
  unmountTestApp();
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

const back = (app: HTMLElement) => app.querySelector<HTMLButtonElement>(".board-chrome .chrome-back .back");

describe("the board in the narrowest desk tier", () => {
  test("the list gives way and the header leads back to it, counting who waits", async () => {
    const app = await boot(820);
    expect(app.classList.contains("desk")).toBeTrue();
    expect(app.classList.contains("rail-hidden")).toBeTrue();
    expect(app.querySelector(".main.main-board .board-shell")).toBeTruthy();
    // Two sessions wait on the reader; the list that would say so is off screen.
    expect(back(app)?.getAttribute("aria-label")).toBe(t("chrome.backWaiting", { n: "2" }));
    expect(app.querySelector(".board-chrome .chrome-back-badge")?.textContent).toBe("2");
    // The way back is not the stand-alone board's bar: the status stays with the float.
    expect(app.querySelector(".board-shell .statusline")).toBeNull();
    expect(app.querySelector(".board-chrome h1.sr-only")?.textContent).toBe(t("board.title"));
  });

  test("with the roomy tier's width the board sits beside the list and has no back", async () => {
    const app = await boot(1180);
    expect(app.classList.contains("desk")).toBeTrue();
    expect(app.classList.contains("rail-hidden")).toBeFalse();
    expect(app.querySelector(".board-chrome .back")).toBeNull();
    expect(app.querySelector(".rail")).toBeTruthy();
  });

  test("back returns the list beside the session it stood beside", async () => {
    const app = await boot(820, "w1:p1");
    await act(async () => {
      back(app)!.click();
      for (let tick = 0; tick < 4; tick += 1) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(currentScreen()).toBe("pane");
    expect(openPaneId()).toBe("w1:p1");
    // It was not opened from a tile, so nothing leads back to the board.
    expect(boardReturn()).toBeFalse();
    expect(app.classList.contains("rail-hidden")).toBeFalse();
    expect(app.querySelector(".desk-return")).toBeNull();
    expect(app.querySelector(".main .pane-root, .main .chat-root, .main .chrome")).toBeTruthy();
  });

  test("with no session open, back is the list beside the empty main column", async () => {
    const app = await boot(820);
    act(() => back(app)!.click());
    await settle();
    expect(currentScreen()).toBe("home");
    expect(app.classList.contains("rail-hidden")).toBeFalse();
    expect(app.querySelector(".main .desk-empty")).toBeTruthy();
  });

  test("a tile opened from it lands beside the list, with the way back to the board", async () => {
    const app = await boot(820);
    await act(async () => {
      app.querySelector<HTMLButtonElement>(".board-pane")!.click();
      for (let tick = 0; tick < 4; tick += 1) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(currentScreen()).toBe("pane");
    expect(boardReturn()).toBeTrue();
    expect(app.classList.contains("rail-hidden")).toBeFalse();
    expect(app.querySelector(".desk-return")?.textContent).toBe(t("desk.backToBoard"));
  });
});
