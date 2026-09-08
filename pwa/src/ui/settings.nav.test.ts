import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { act } from "react";
import { leaveReactScreen } from "./react/root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const {
  DEFAULT_TERM_MODE_KEY,
  DEFAULT_COMPOSE_LIVE_KEY,
  app,
  loadPaneTermModes,
  paneComposeLive,
  paneTermMode,
  parseTermMode,
  setDefaultComposeLive,
  setDefaultTermMode,
  setPaneComposeLive,
  setPaneTermMode,
  state,
} = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { lang, setLang, setLangPref, t } = await import("../lib/i18n.ts");

const { renderApp } = await import("./react/app-screen");
function paint(): void { act(renderApp); }

const originalFetch = globalThis.fetch;
const { checkDaemonRelease } = await import("../daemon-update");
async function click(label: string): Promise<void> {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.innerHTML.slice(0, 280)}`);
  await act(async () => { el.click(); await checkDaemonRelease(); });
}

function bootHomeWithStalePane(): void {
  state.phase = "live";
  state.screen = "home";
  state.paneId = "p1";
  state.agents = [{
    paneId: "p1",
    agent: "herdr",
    hasAgent: true,
    status: "idle",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
  }];
  state.live = null;
  setRenderer(paint);
  paint();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.assign(state, { phase: "live", screen: "home", fullTerminal: false, agentChat: false,
    credential: null, live: null, computers: [], agents: [], paneId: "", panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, operationBusy: false, networkOnline: true, runtimeKind: "herdr",
    herdHost: "", notice: null, settingsLoading: false, deviceList: [], devicesError: "", pushConfigError: "",
    pushEnabled: null, pushSubscribed: null });
  setLang("zh");
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
});

afterEach(() => {
  act(() => leaveReactScreen());
  globalThis.fetch = originalFetch;
  setRenderer(() => {});
  state.screen = "home";
  state.computersFrom = "home";
  state.paneId = "";
  state.defaultTermMode = "auto";
  state.networkMode = "auto";
  state.paneTermModes = {};
  state.defaultComposeLive = false;
  state.paneComposeLive = {};
  localStorage.removeItem(DEFAULT_TERM_MODE_KEY);
  localStorage.removeItem(DEFAULT_COMPOSE_LIVE_KEY);
  setLang("zh");
  try {
    localStorage.removeItem("pairfob_lang");
  } catch {
    /* ignore */
  }
  app.replaceChildren();
});

describe("settings computers", () => {
  test("one computer row opens the list that both switches and adds", async () => {
    bootHomeWithStalePane();
    await click("设置");
    expect(app.querySelector("button.set-nav")?.getAttribute("aria-label")).toBe("电脑");
    expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("切换电脑");
    expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("添加另一台电脑");
    await click("电脑");
    expect(state.screen).toBe("computers");
    expect(state.computersFrom).toBe("settings");
    expect(Boolean(app.querySelector(".computer-add"))).toBe(true);
    await click("返回");
    expect(state.screen).toBe("settings");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("设置");
  });
});

describe("settings back", () => {
  test("on a phone, back from settings returns to the list even if a pane is remembered", async () => {
    bootHomeWithStalePane();
    await click("设置");
    expect(state.screen).toBe("settings");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("设置");
    await click("返回");
    expect(state.screen).toBe("home");
    expect((app.querySelector(".settings-page")) === null).toBe(true);
    expect(app.querySelector(".wordmark")?.textContent).toBe("pairfob");
  });
});

describe("default terminal mode", () => {
  test("parseTermMode fails closed to auto", async () => {
    expect(parseTermMode("auto")).toBe("auto");
    expect(parseTermMode("full")).toBe("full");
    expect(parseTermMode("agent")).toBe("agent");
    expect(parseTermMode("guided")).toBe("guided");
    expect(parseTermMode("nope")).toBe("auto");
    expect(parseTermMode(null, "full")).toBe("full");
  });

  test("settings offers auto and the three explicit views, then persists an override", async () => {
    bootHomeWithStalePane();
    await click("设置");
    const defaults = [...app.querySelectorAll(".set-heading")].find((row) => row.querySelector(".set-title")?.textContent === "会话默认");
    const card = defaults?.nextElementSibling;
    expect(Boolean(card?.querySelector('[aria-label="默认模式"]'))).toBe(true);
    expect(Boolean(card?.querySelector('[aria-label="终端输入方式"]'))).toBe(true);
    const group = app.querySelector('[aria-label="默认模式"]');
    expect(Boolean(group)).toBe(true);
    expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["自动", "控制", "终端", "对话"]);
    expect(group!.querySelector('[aria-checked="true"]')?.textContent).toBe("自动");
    await click("终端");
    expect(state.defaultTermMode).toBe("full");
    expect(localStorage.getItem(DEFAULT_TERM_MODE_KEY)).toBe("full");
    expect(app.querySelector('[aria-label="默认模式"] [aria-checked="true"]')?.textContent).toBe("终端");
  });

  test("a pane without its own choice follows the default", async () => {
    state.defaultTermMode = "full";
    state.paneTermModes = {};
    expect(paneTermMode("p1")).toBe("full");
    setPaneTermMode("p1", "guided");
    setDefaultTermMode("agent");
    expect(paneTermMode("p1")).toBe("guided");
    expect(paneTermMode("p2")).toBe("agent");
  });

  test("a per-pane Auto choice survives storage reload", async () => {
    state.credential = null;
    state.paneTermModes = {};
    setPaneTermMode("p1", "auto");
    expect(loadPaneTermModes()).toEqual({ p1: "auto" });
  });
});

describe("default input mode", () => {
  test("settings changes only the default while pane choices remain independent", async () => {
    bootHomeWithStalePane();
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);
    await click("设置");

    const group = app.querySelector('[aria-label="终端输入方式"]');
    expect(group?.querySelector('[aria-checked="true"]')?.textContent).toBe("组字");
    await click("实时");

    expect(state.defaultComposeLive).toBeTrue();
    expect(localStorage.getItem(DEFAULT_COMPOSE_LIVE_KEY)).toBe("1");
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
    expect(paneComposeLive("p3")).toBeTrue();
  });

  test("a pane switch can override the default without affecting another pane", async () => {
    setDefaultComposeLive(false);
    setPaneComposeLive("p1", true);
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
  });
});

describe("language", () => {
  test("settings can pin english and follow the browser again", async () => {
    bootHomeWithStalePane();
    await click("设置");
    const group = app.querySelector('[aria-label="语言"]');
    expect(Boolean(group)).toBe(true);
    expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["跟随浏览器", "中文", "English"]);
    await click("English");
    expect(lang()).toBe("en");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("Settings");
    expect(app.querySelector('[aria-label="Language"] [aria-checked="true"]')?.textContent).toBe("English");
    await click("Browser default");
    expect(document.documentElement.lang === "en" || document.documentElement.lang === "zh-CN").toBe(true);
    setLangPref("zh");
    expect(t("home.settings")).toBe("设置");
  });
});
