import { Window } from "happy-dom";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "Node",
  "DocumentFragment",
  "ResizeObserver",
  "MutationObserver",
  "DOMParser",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.history = happy.history;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
g.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
g.visualViewport = happy.visualViewport;
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, paneTermMode, setPaneTermMode, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderPane, goBackFromPane } = await import("./pane.ts");
const { disposeFullTerminal, leaveFullTerminal, setTermFit } = await import("./full-terminal.ts");

const DRAFT = "keep-draft";

function live() {
  return {
    terminalOpen: () => new Promise(() => undefined),
    terminalClose: async () => undefined,
    terminalInput: async () => undefined,
    terminalResize: async () => undefined,
    terminalScroll: async () => undefined,
    sendText: async () => undefined,
    sendKeys: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  };
}

function bootFullTerminal(): void {
  disposeFullTerminal();
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.paneText = "ready";
  state.composeDraft = DRAFT;
  state.agents = [{
    paneId: "p1",
    agent: "herdr",
    hasAgent: true,
    status: "idle",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
  }];
  state.live = live();
  state.fullTerminal = true;
  setPaneTermMode("p1", "full");
  setRenderer(() => renderPane());
  renderPane();
}

function click(selector: string): void {
  const el = app.querySelector(selector);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${selector}: ${app.innerHTML.slice(0, 200)}`);
  el.click();
}

beforeAll(() => {
  setRenderer(() => renderPane());
});

afterEach(async () => {
  await leaveFullTerminal({ rememberGuided: false, paint: false });
  disposeFullTerminal();
  state.screen = "pane";
  state.composeDraft = "";
  state.paneTermModes = {};
  state.termFit = "pan";
  state.live = null;
  app.replaceChildren();
});

describe("complete-terminal remembers its mode per pane", () => {
  test("‹ returns to the session list and keeps complete-terminal as the pane mode", async () => {
    bootFullTerminal();
    expect(app.querySelector(".full-terminal-root")).toBeTruthy();
    expect(app.querySelector(".dock")).toBeNull();
    expect(app.querySelector(".full-terminal-pad")).toBeTruthy();
    expect(app.querySelector('.full-terminal-pad [aria-label="上箭头"]')).toBeTruthy();
    click(".full-terminal-chrome .back");
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    await Promise.resolve();
    expect(state.fullTerminal).toBe(false);
    expect(state.screen).toBe("home");
    expect(paneTermMode("p1")).toBe("full");
    expect(app.querySelector(".full-terminal-root")).toBeNull();
  });

  test("reopening the pane restores complete-terminal", async () => {
    bootFullTerminal();
    click(".full-terminal-chrome .back");
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    await Promise.resolve();
    expect(state.screen).toBe("home");
    state.screen = "pane";
    state.paneId = "p1";
    state.fullTerminal = paneTermMode("p1") === "full";
    renderPane();
    expect(state.fullTerminal).toBe(true);
    expect(app.querySelector(".full-terminal-root")).toBeTruthy();
    expect(app.querySelector(".dock")).toBeNull();
  });

  test("leaving the terminal mode from the menu returns to guided", async () => {
    bootFullTerminal();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
    expect(app.querySelector(".full-terminal-exit")).toBeNull();
    await leaveFullTerminal();
    expect(state.fullTerminal).toBe(false);
    expect(state.screen).toBe("pane");
    expect(paneTermMode("p1")).toBe("guided");
    expect(state.composeDraft).toBe(DRAFT);
    expect(app.querySelector(".dock")).toBeTruthy();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
  });

  test("swipe-back from complete-terminal returns to the list", async () => {
    bootFullTerminal();
    goBackFromPane();
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    await Promise.resolve();
    expect(state.screen).toBe("home");
    expect(paneTermMode("p1")).toBe("full");
  });

  test("the host keeps a side-pan canvas for an 80-column PTY", () => {
    bootFullTerminal();
    const host = app.querySelector(".full-terminal-host");
    expect(host?.classList.contains("is-pan")).toBe(true);
    expect(host?.querySelector(".full-terminal-pan")).toBeTruthy();
    expect(host?.querySelector(".full-terminal-canvas")).toBeTruthy();
    expect(host?.querySelector(".full-terminal-scroll")).toBeTruthy();
    setTermFit("fit");
    expect(app.querySelector(".full-terminal-host")?.classList.contains("is-pan")).toBe(false);
    setTermFit("pan");
    expect(app.querySelector(".full-terminal-host")?.classList.contains("is-pan")).toBe(true);
  });

  test("list-back lives on the guided chrome after leaving", async () => {
    bootFullTerminal();
    await leaveFullTerminal();
    click(".chrome .back");
    expect(state.screen).toBe("home");
    expect(state.composeDraft).toBe("");
    expect(paneTermMode("p1")).toBe("guided");
  });
});
