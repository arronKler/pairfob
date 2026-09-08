import { resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { setLang, t } from "../../lib/i18n";
import { app, clearNotice, showStatus, state } from "../../state";
import { patchChromeTitle, type SessionHandlers } from "./view";
import { leaveReactScreen, renderReactScreen } from "../react/root";
import { SessionPane } from "../react/session-pane";
import { setRenderer } from "../../paint";

const viewSource = await Bun.file(new URL("./view.ts", import.meta.url)).text();
const chromeSource = await Bun.file(new URL("../react/session-chrome.tsx", import.meta.url)).text();
const paneSource = await Bun.file(new URL("../react/session-pane.tsx", import.meta.url)).text();

let connected = true;
let back = 0, menu = 0, inspect = 0, switched = 0;
const handlers: SessionHandlers = {
  onBack: () => { back++; },
  onMenu: () => { menu++; },
  onSwitch: () => { switched++; },
  onWorkspace: () => { inspect++; },
};

function paint(includeBack = true): void {
  act(() => renderReactScreen(createElement(SessionPane, {
    includeBack, handlers, scroll: { top: 0, left: 0, bottom: true },
  })));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  act(leaveReactScreen);
  app.replaceChildren();
  setRenderer(() => {});
  setLang("zh");
  connected = true;
  back = menu = inspect = switched = 0;
  Object.assign(state, {
    phase: "live",
    screen: "pane",
    paneId: "p1",
    paneText: "first output",
    paneHash: "hash",
    termSelect: false,
    operationBusy: false,
    composeFocused: false,
    composeDraft: "", composeLive: false, composeIME: false,
    keysExpanded: false, padKind: "keys", paneFollow: true, paneUnread: false, paneRow: null,
    agentChat: false,
    fullTerminal: false,
    networkOnline: true,
    runtimeKind: "herdr",
    agents: [{
      paneId: "p1",
      agent: "codex",
      hasAgent: true,
      status: "working",
      workspaceLabel: "demo",
      cwd: "/repo/project",
      tabId: "t1",
      workspaceId: "w1",
    }],
    live: { isConnected: () => connected },
  });
  clearNotice();
});

afterEach(() => {
  act(() => { leaveReactScreen(); clearNotice(); });
  state.screen = "home";
  state.live = null;
  state.agents = [];
  state.composeDraft = "";
  setRenderer(() => {});
  app.replaceChildren();
});

describe("pane header keeps status surfaces in step", () => {
  /**
   * A working/idle flip seen while the pane is open runs patchChromeTitle, not a
   * full render, on a phone viewport. Status, the accessible name, and the
   * interrupt button must stay on the same published snapshot.
   */
  test("the patch path goes through the same status sync as the builder", () => {
    paint();
    const title = app.querySelector<HTMLButtonElement>(".chrome-title")!;
    expect(app.querySelector(".icon-stop") !== null).toBeTrue();
    expect(title.getAttribute("aria-label")).toContain(t("status.working"));
    state.agents = state.agents.map((agent) => ({ ...agent, status: "idle" }));
    act(() => patchChromeTitle());
    expect(app.querySelector(".chrome-title") === title).toBeTrue();
    expect(app.querySelector(".icon-stop")).toBeNull();
    expect(title.getAttribute("aria-label")).toContain(t("status.idle"));
    expect(viewSource).toContain("flushSync(notifySessionUI)");
    expect(viewSource).toContain("export function patchChromeTitle");
  });

  test("status sync owns the accessible name and the interrupt button", () => {
    paint();
    const title = app.querySelector<HTMLButtonElement>(".chrome-title")!;
    expect(title.getAttribute("aria-label")).toContain(t("status.working"));
    expect(app.querySelector(".icon-stop")?.getAttribute("aria-label")).toBe(t("pane.interrupt"));
    expect(chromeSource).toContain("icon-stop");
    expect(chromeSource).toContain('t("pane.interrupt")');
    expect(chromeSource).toContain('t("pane.menuTitle")');
    expect(chromeSource).not.toContain("title.after");
    expect(viewSource).not.toContain("syncChromeStop");
  });

  test("nothing else builds the interrupt button behind the sync's back", () => {
    expect(viewSource).not.toContain("icon-stop");
    paint();
    expect(app.querySelectorAll(".icon-stop")).toHaveLength(1);
  });

  test("pane modes live in the more menu, not as extra chrome slots", () => {
    paint();
    const chrome = app.querySelector(".chrome")!;
    expect(chrome.querySelector(".mode-switch")).toBeNull();
    expect(chrome.textContent).not.toContain("完整终端");
    expect(chrome.textContent).not.toContain("进入对话");
    expect(chrome.textContent).not.toContain("更多操作");
    expect(viewSource).not.toContain("mode-switch");
    expect(viewSource).not.toContain("完整终端");
    expect(viewSource).not.toContain("进入对话");
    expect(viewSource).not.toContain("更多操作");
    expect(viewSource).not.toContain("full-terminal-retry");
    expect(viewSource).not.toContain("退出完整终端");
    expect(chromeSource).toContain("handlers.onWorkspace");
    expect(chromeSource).toContain("handlers.onMenu");
  });

  test("workspace inspection is a first-class trailing action before more", () => {
    paint();
    expect([...app.querySelectorAll(".chrome-actions button")].map((button) => button.className))
      .toEqual(["icon-btn icon-stop", "icon-btn icon-workspace", "icon-btn icon-more"]);
    expect(app.querySelector(".icon-workspace")?.getAttribute("aria-label")).toBe(t("workspace.open"));
    expect(chromeSource).not.toContain("labEnabled");
    const workspace = chromeSource.indexOf("icon-workspace");
    const menu = chromeSource.indexOf("icon-more");
    expect(workspace).toBeGreaterThan(-1);
    expect(menu).toBeGreaterThan(workspace);
  });

  test("in-place pane reads keep the terminal Enter control in sync", () => {
    expect(viewSource).toContain("syncSendButton()");
    expect(viewSource).not.toContain("promptPanel");
  });

  test("app notices sit under the chrome, not in the dock or select bar", () => {
    paint();
    const pane = app.querySelector(".pane-root");
    act(() => showStatus("session notice", true));
    expect(app.querySelector(".pane-root") === pane).toBeTrue();
    const notice = app.querySelector("[data-react-notice]")!;
    expect(notice.previousElementSibling?.className).toBe("chrome");
    expect(notice.nextElementSibling?.classList.contains("term-wrap")).toBeTrue();
    expect(paneSource).toContain("<AppNotice />");
    expect(viewSource).not.toContain("appendNotice");
    expect(viewSource).not.toContain("selectBar");
    expect(viewSource).not.toContain("noteNode");
  });

  test("the status dot sits with the status line so the title can use the full width", () => {
    paint();
    const title = app.querySelector(".chrome-title")!;
    const name = title.querySelector(".chrome-name");
    const meta = title.querySelector(".chrome-meta");
    const dot = title.querySelector(".agent-dot");
    expect(name !== null).toBeTrue();
    expect(meta !== null).toBeTrue();
    expect(dot !== null).toBeTrue();
    expect(name!.nextElementSibling === meta).toBeTrue();
    expect(meta!.querySelector(".agent-dot") === dot).toBeTrue();
    expect(meta!.querySelector(".chrome-meta-text") !== null).toBeTrue();
    expect(title.querySelector(".chrome-name-row")).toBeNull();
    expect(chromeSource).toContain("chrome-name");
    expect(chromeSource).toContain("chrome-meta-text");
    expect(chromeSource).toContain("agent-dot");
    expect(chromeSource).not.toContain("chrome-name-row");
  });

  test("the visible subtitle is a short status line, not the dashboard card meta", () => {
    paint();
    const visible = app.querySelector(".chrome-meta-text")?.textContent ?? "";
    expect(visible).toContain("project");
    expect(visible).toBe(`${t("status.working")} · project`);
    const title = app.querySelector<HTMLButtonElement>(".chrome-title")!;
    expect(title.title).toBe(`demo · ${t("status.working")} · codex · project`);
    expect(title.getAttribute("aria-label")).toBe(t("chrome.switchAriaMeta", {
      title: "demo", line: `${t("status.working")} · codex · project`,
    }));
    state.agents.push({ ...state.agents[0]!, paneId: "p2" });
    act(patchChromeTitle);
    expect(app.querySelector(".chrome-meta-text")?.textContent)
      .toBe(`${t("status.working")} · project · ${t("chrome.split")}`);
    expect(chromeSource).toContain("cwdName(selected.cwd)");
    expect(chromeSource).toContain('tabIsSplit(selected, state.agents) ? t("chrome.split")');
    expect(chromeSource).toContain("agentMeta(selected)");
    expect(chromeSource).toContain("chromeName(selected)");
    expect(chromeSource.indexOf("agentMeta(selected)")).toBeGreaterThan(-1);
    expect(chromeSource.indexOf("cwdName(selected.cwd)")).toBeGreaterThan(-1);
  });
});
