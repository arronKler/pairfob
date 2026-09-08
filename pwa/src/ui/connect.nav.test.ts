import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { act } from "react";
import { leaveReactScreen } from "./react/root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { app, clearNotice, showError, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderConnect: paintConnect } = await import("./connect.ts");
const { setLang } = await import("../lib/i18n.ts");

function paintAdd(busy = false): void {
  state.phase = busy ? "pairing" : "connect";
  state.addingComputer = true;
  state.fragment = null;
  state.pairManualOpen = false;
  state.pairAwaitingApproval = false;
  state.pairFailedStep = null;
  renderConnect();
}

function renderConnect(): void { act(paintConnect); }

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.assign(state, { phase: "live", screen: "home", fullTerminal: false, agentChat: false,
    credential: null, live: null, computers: [], agents: [], paneId: "", panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, operationBusy: false, networkOnline: true, runtimeKind: "herdr",
    herdHost: "", notice: null, settingsLoading: false, deviceList: [], devicesError: "", pushConfigError: "",
    pushEnabled: null, pushSubscribed: null });
  setLang("zh");
  setRenderer(() => {
    if (state.phase === "connect" || state.phase === "pairing") renderConnect();
  });
});

afterEach(() => {
  act(() => leaveReactScreen());
  setRenderer(() => {});
  state.phase = "boot";
  state.addingComputer = false;
  state.computers = [];
  state.fragment = null;
  state.pairManualOpen = false;
  state.pairAwaitingApproval = false;
  state.pairFailedStep = null;
  clearNotice();
  setLang("zh");
  try {
    localStorage.removeItem("pairfob_lang");
    document.cookie = "pairfob_lang=;path=/;max-age=0";
  } catch {
    /* ignore */
  }
  app.replaceChildren();
});

describe("add-computer pairing chrome", () => {
  test("first-run pairing keeps the prelude, not a settings topbar", () => {
    state.phase = "connect";
    state.addingComputer = false;
    state.computers = [];
    renderConnect();
    expect(Boolean(app.querySelector(".prelude"))).toBe(true);
    expect((app.querySelector(".settings-page")) === null).toBe(true);
    expect((app.querySelector(".topbar-title")) === null).toBe(true);
    expect(app.querySelector(".prelude-title")?.textContent).toBe("连上你的电脑");
  });

  test("adding another computer uses the settings-page topbar", () => {
    paintAdd();
    expect((app.querySelector(".prelude")) === null).toBe(true);
    expect(Boolean(app.querySelector(".settings-page"))).toBe(true);
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect((app.querySelector(".prelude-title")) === null).toBe(true);
    expect(app.querySelector(".back")?.getAttribute("aria-label")).toBe("返回");
    expect(app.querySelector(".btn-scan")?.textContent).toBe("扫码连接");
  });

  test("waiting for the computer still keeps the back bar", () => {
    paintAdd(true);
    expect(Boolean(app.querySelector(".settings-page"))).toBe(true);
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(app.querySelector(".pair-wait-title")?.textContent).toBe("正在验证配对码");
  });

  test("the rail marks the step pairing is really on, and the step it died on", () => {
    paintAdd(true);
    const states = () => [...app.querySelectorAll(".pair-step")].map((step) => step.className);
    expect(states()).toEqual(["pair-step is-done", "pair-step is-active", "pair-step is-todo"]);

    state.pairAwaitingApproval = true;
    renderConnect();
    expect(states()).toEqual(["pair-step is-done", "pair-step is-done", "pair-step is-active"]);

    // A failure freezes the rail so the error has a step to sit on.
    state.phase = "connect";
    state.pairAwaitingApproval = false;
    state.pairFailedStep = "verify";
    act(() => showError("电脑上没有确认。", true));
    state.pairErrorTarget = null;
    renderConnect();
    expect(states()).toEqual(["pair-step is-done", "pair-step is-done", "pair-step is-failed"]);
    expect(app.querySelector(".pair-step-note")?.textContent).toBe("电脑上没有确认。");
    // The same sentence must not also appear as a standalone notice.
    expect((app.querySelector(".notice-error")) === null).toBe(true);
    state.pairFailedStep = null;
  });

  test("the pairing page can switch to English", () => {
    state.phase = "connect";
    state.addingComputer = false;
    state.computers = [];
    renderConnect();
    const select = app.querySelector<HTMLSelectElement>('select[aria-label="语言"]');
    expect(Boolean(select)).toBe(true);
    expect([...select!.options].map((option) => option.textContent)).toEqual(["自动", "中文", "English"]);
    expect((app.querySelector(".trust")?.nextElementSibling) === (app.querySelector(".connect-lang"))).toBe(true);
    select!.value = "en";
    act(() => { select!.dispatchEvent(new happy.Event("change", { bubbles: true })); });
    expect(app.querySelector(".prelude-title")?.textContent).toBe("Connect your computer");
    expect(app.querySelector(".btn-scan")?.textContent).toBe("Scan to connect");
    expect(app.querySelector<HTMLSelectElement>('select[aria-label="Language"]')?.value).toBe("en");
  });

  test("adding another computer puts language in the topbar", () => {
    paintAdd();
    const lang = app.querySelector(".connect-lang");
    expect(app.querySelector(".topbar")?.contains(lang)).toBe(true);
    expect((app.querySelector(".trust")?.nextElementSibling) === null).toBe(true);
    expect((app.querySelector(".seg")) === null).toBe(true);
  });
});
