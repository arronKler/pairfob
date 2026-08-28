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
  app,
  paneTermMode,
  parseTermMode,
  setDefaultTermMode,
  setPaneTermMode,
  state,
} = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderHome } = await import("./home.ts");
const { renderSettings } = await import("./settings.ts");
const { renderPane } = await import("./pane.ts");

function paint(): void {
  if (state.screen === "settings") renderSettings();
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
  state.paneId = "";
  state.defaultTermMode = "guided";
  state.paneTermModes = {};
  localStorage.removeItem(DEFAULT_TERM_MODE_KEY);
  app.replaceChildren();
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
  test("parseTermMode fails closed to guided", () => {
    expect(parseTermMode("full")).toBe("full");
    expect(parseTermMode("agent")).toBe("agent");
    expect(parseTermMode("guided")).toBe("guided");
    expect(parseTermMode("nope")).toBe("guided");
    expect(parseTermMode(null, "full")).toBe("full");
  });

  test("settings offers the three views and persists the choice", () => {
    bootHomeWithStalePane();
    click("设置");
    const group = app.querySelector('[aria-label="默认模式"]');
    expect(group).toBeTruthy();
    expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["控制", "终端", "对话"]);
    expect(group!.querySelector('[aria-checked="true"]')?.textContent).toBe("控制");
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

