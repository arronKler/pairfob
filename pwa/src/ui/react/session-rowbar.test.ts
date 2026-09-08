import { resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { leaveReactScreen, renderReactScreen } from "./root";
import { app, clearNotice, state } from "../../state";
import { setLang } from "../../lib/i18n";
import { setRenderer } from "../../paint";
import { discardEmptyPaneRow, openRow } from "../session/rowbar";
import { displayedTermModel } from "../session/term";
import { paneModel } from "../session/model";
import { SessionRowBar } from "./session-rowbar";

function paint(): void {
  act(() => renderReactScreen(createElement(SessionRowBar)));
}

function click(label: string): HTMLButtonElement {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  act(() => { el.click(); });
  return el;
}

function boot(text = "open /tmp/demo/readme.md"): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.paneText = text;
  state.paneHash = "h0";
  state.termSelect = false;
  state.paneRow = null;
  state.composeDraft = "";
  state.composeLive = false;
  state.notice = null;
  setRenderer(paint);
  paint();
}

let clipboard: PropertyDescriptor | undefined;
beforeEach(async () => {
  await resetBoardTestDOM();
  act(leaveReactScreen);
  app.replaceChildren();
  setLang("zh");
  setRenderer(() => {});
  Object.assign(state, { live: null, agents: [], fullTerminal: false, agentChat: false,
    composeIME: false, composeFocused: false, operationBusy: false, paneFollow: true });
  clearNotice();
  clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
});

afterEach(async () => {
  await act(async () => { await Promise.resolve(); });
  act(leaveReactScreen);
  state.termSelect = false;
  displayedTermModel(paneModel());
  state.paneRow = null;
  state.composeDraft = "";
  clearNotice();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  app.replaceChildren();
  setRenderer(() => {});
});

describe("react session row bar", () => {
  test("render does not clear an empty selected row; the controller does", () => {
    boot("   ");
    state.paneRow = 0;
    paint();
    expect(state.paneRow).toBe(0);
    expect(app.querySelector(".row-bar")).toBeNull();
    expect(discardEmptyPaneRow(paneModel())).toBeTrue();
    expect(state.paneRow).toBeNull();
  });

  test("openRow rejects an empty line and the bar matches the legacy actions", () => {
    boot("hello from /tmp/demo/app.ts");
    act(() => { openRow(0); });
    const bar = app.querySelector(".row-bar");
    expect(bar?.getAttribute("role")).toBe("group");
    expect(bar?.hasAttribute("data-react-session-rowbar")).toBeTrue();
    expect(app.querySelector(".row-quote")?.textContent).toContain("hello from /tmp/demo/app.ts");
    const labels = [...app.querySelectorAll(".row-act")].map((el) => el.textContent);
    expect(labels.some((text) => text?.includes("复制整行"))).toBeTrue();
    expect(labels.some((text) => text?.includes("/tmp/demo/app.ts"))).toBeTrue();
    expect(labels).toContain("引用到输入框");
    expect(labels).toContain("选择文本");
    state.paneText = "   ";
    let opened: ReturnType<typeof openRow>;
    act(() => { opened = openRow(0); });
    expect(opened).toBeUndefined();
    expect(state.paneRow).toBeNull();
  });

  test("quote inserts into compose and select-text enters selection mode", () => {
    boot("quoted line");
    act(() => { openRow(0); });
    click("引用到输入框");
    expect(state.composeDraft).toContain("quoted line");
    expect(state.paneRow).toBeNull();
    act(() => { openRow(0); });
    click("选择文本");
    expect(state.termSelect).toBeTrue();
    expect(state.paneRow).toBeNull();
  });

  test("controller still normalizes empty selection without a React render", () => {
    boot("hello");
    state.paneRow = 0;
    state.paneText = "   ";
    expect(discardEmptyPaneRow(paneModel())).toBeTrue();
    expect(state.paneRow).toBeNull();
  });

  test("copy uses the clipboard controller and closes the bar", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => written.push(text) },
    });
    boot("copy me");
    act(() => { openRow(0); });
    click("复制整行");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(written).toEqual(["copy me"]);
    expect(state.paneRow).toBeNull();
    expect(app.querySelector(".row-bar")).toBeNull();
  });
});
