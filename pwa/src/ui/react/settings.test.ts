import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_COMPOSE_LIVE_KEY,
  DEFAULT_TERM_MODE_KEY,
  app,
  paneComposeLive,
  paneTermMode,
  setDefaultComposeLive,
  setDefaultTermMode,
  setPaneComposeLive,
  setPaneTermMode,
  state,
} from "../../state";
import { lang, setLang, setLangPref, t } from "../../lib/i18n";
import { createElement } from "react";
import { SettingsScreen } from "./settings";
import { click, installPainter, paintApp, paintSettings, resetRoot, update } from "../../../test-support/settings-render";

beforeEach(async () => {
  await resetTestDOM();
  setLangPref("zh");
});

function bootLiveHome(): void {
  state.phase = "live";
  state.screen = "home";
  state.paneId = "p1";
  state.agents = [
    {
      paneId: "p1",
      agent: "herdr",
      hasAgent: true,
      status: "idle",
      workspaceLabel: "demo",
      cwd: "/tmp/demo",
    },
  ];
  state.live = null;
  installPainter();
  state.screen = "settings";
  paintApp();
}

afterEach(() => {
  closeTestDialogs();
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
  setLangPref("auto");
  setLang("zh");
  resetRoot();
});

describe("settings computers", () => {
  test("one computer row opens the list that both switches and adds", () => {
    bootLiveHome();
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
    bootLiveHome();
    expect(state.screen).toBe("settings");
    expect(app.querySelector(".topbar-title")?.textContent).toBe("设置");
    click("返回");
    expect(state.screen).toBe("home");
    expect(app.querySelector(".settings-page")).toBeNull();
  });
});

describe("default terminal mode", () => {
  test("settings offers auto and the three explicit views, then persists an override", () => {
    bootLiveHome();
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
});

describe("default input mode", () => {
  test("settings changes only the default while pane choices remain independent", () => {
    bootLiveHome();
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);
    paintApp();
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
    bootLiveHome();
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

describe("settings content", () => {
  test("content with no back bar has no extra page wrapper", () => {
    paintSettings(false);
    expect(app.querySelector(".page")).toBeNull();
    expect(app.querySelector(".topbar")).toBeNull();
    expect(app.querySelector(".set-heading .set-title")?.textContent).toBe("连接");
    expect(app.querySelector(".set-heading")).toBeTruthy();
  });

  test("repaint keeps the focused network radio", () => {
    bootLiveHome();
    state.p2pEnabled = true;
    paintApp();
    const relay = [...app.querySelectorAll('[aria-label="网络连接方式"] button')].find((el) => el.textContent === "Relay");
    if (!(relay instanceof HTMLButtonElement)) throw new Error("missing Relay");
    relay.focus();
    expect(document.activeElement).toBe(relay);
    update(createElement(SettingsScreen));
    expect(document.activeElement).toBeInstanceOf(HTMLButtonElement);
    expect((document.activeElement as HTMLButtonElement).textContent).toBe("Relay");
    expect((document.activeElement as HTMLButtonElement).getAttribute("role")).toBe("radio");
  });
});
