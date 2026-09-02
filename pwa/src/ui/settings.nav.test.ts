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
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

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
const { renderHome } = await import("./home.ts");
const { renderSettings } = await import("./settings.ts");
const { renderComputers } = await import("./computers.ts");
const { renderPane } = await import("./pane.ts");
const { lang, setLang, setLangPref, t } = await import("../lib/i18n.ts");

function paint(): void {
  if (state.screen === "settings") renderSettings();
  else if (state.screen === "computers") renderComputers();
  else if (state.screen === "pane") renderPane();
  else renderHome();
}

function click(label: string): void {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.innerHTML.slice(0, 280)}`);
  el.click();
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

afterEach(() => {
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
  test("one computer row opens the list that both switches and adds", () => {
    bootHomeWithStalePane();
    click("设置");
    expect(app.querySelector("button.set-nav")?.getAttribute("aria-label")).toBe("电脑");
    expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("切换电脑");
    expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("添加另一台电脑");
    click("电脑");
    expect(state.screen).toBe("computers");
    expect(state.computersFrom).toBe("settings");
    expect(app.querySelector(".computer-add")).toBeTruthy();
    click("返回");
    expect(state.screen).toBe("settings");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("设置");
  });
});

describe("settings back", () => {
  test("on a phone, back from settings returns to the list even if a pane is remembered", () => {
    bootHomeWithStalePane();
    click("设置");
    expect(state.screen).toBe("settings");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("设置");
    click("返回");
    expect(state.screen).toBe("home");
    expect(app.querySelector(".settings-page")).toBeNull();
    expect(app.querySelector(".wordmark")?.textContent).toBe("pairfob");
  });
});

describe("default terminal mode", () => {
  test("parseTermMode fails closed to auto", () => {
    expect(parseTermMode("auto")).toBe("auto");
    expect(parseTermMode("full")).toBe("full");
    expect(parseTermMode("agent")).toBe("agent");
    expect(parseTermMode("guided")).toBe("guided");
    expect(parseTermMode("nope")).toBe("auto");
    expect(parseTermMode(null, "full")).toBe("full");
  });

  test("settings offers auto and the three explicit views, then persists an override", () => {
    bootHomeWithStalePane();
    click("设置");
    const defaults = [...app.querySelectorAll(".set-heading")].find((row) => row.querySelector(".set-title")?.textContent === "会话默认");
    const card = defaults?.nextElementSibling;
    expect(card?.querySelector('[aria-label="默认模式"]')).toBeTruthy();
    expect(card?.querySelector('[aria-label="终端输入方式"]')).toBeTruthy();
    const group = app.querySelector('[aria-label="默认模式"]');
    expect(group).toBeTruthy();
    expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["自动", "控制", "终端", "对话"]);
    expect(group!.querySelector('[aria-checked="true"]')?.textContent).toBe("自动");
    click("终端");
    expect(state.defaultTermMode).toBe("full");
    expect(localStorage.getItem(DEFAULT_TERM_MODE_KEY)).toBe("full");
    expect(app.querySelector('[aria-label="默认模式"] [aria-checked="true"]')?.textContent).toBe("终端");
  });

  test("a pane without its own choice follows the default", () => {
    state.defaultTermMode = "full";
    state.paneTermModes = {};
    expect(paneTermMode("p1")).toBe("full");
    setPaneTermMode("p1", "guided");
    setDefaultTermMode("agent");
    expect(paneTermMode("p1")).toBe("guided");
    expect(paneTermMode("p2")).toBe("agent");
  });

  test("a per-pane Auto choice survives storage reload", () => {
    state.credential = null;
    state.paneTermModes = {};
    setPaneTermMode("p1", "auto");
    expect(loadPaneTermModes()).toEqual({ p1: "auto" });
  });
});

describe("default input mode", () => {
  test("settings changes only the default while pane choices remain independent", () => {
    bootHomeWithStalePane();
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);
    click("设置");

    const group = app.querySelector('[aria-label="终端输入方式"]');
    expect(group?.querySelector('[aria-checked="true"]')?.textContent).toBe("组字");
    click("实时");

    expect(state.defaultComposeLive).toBeTrue();
    expect(localStorage.getItem(DEFAULT_COMPOSE_LIVE_KEY)).toBe("1");
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
    expect(paneComposeLive("p3")).toBeTrue();
  });

  test("a pane switch can override the default without affecting another pane", () => {
    setDefaultComposeLive(false);
    setPaneComposeLive("p1", true);
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
  });
});

describe("language", () => {
  test("settings can pin english and follow the browser again", () => {
    bootHomeWithStalePane();
    click("设置");
    const group = app.querySelector('[aria-label="语言"]');
    expect(group).toBeTruthy();
    expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["跟随浏览器", "中文", "English"]);
    click("English");
    expect(lang()).toBe("en");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("Settings");
    expect(app.querySelector('[aria-label="Language"] [aria-checked="true"]')?.textContent).toBe("English");
    click("Browser default");
    expect(document.documentElement.lang === "en" || document.documentElement.lang === "zh-CN").toBe(true);
    setLangPref("zh");
    expect(t("home.settings")).toBe("设置");
  });
});
