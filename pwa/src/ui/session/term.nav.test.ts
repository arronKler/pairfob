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
  "HTMLDialogElement",
  "Node",
  "DocumentFragment",
  "PointerEvent",
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

const { app, state } = await import("../../state.ts");
const { setRenderer } = await import("../../paint.ts");
const { renderPane } = await import("../pane.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../../lib/operations.ts");
const { guidedScrollController } = await import("./guided-scroll.ts");

function live() {
  return {
    history: async () => ({ items: [{ role: "assistant", text: "old\nline" }], next_cursor: null, truncated: false }),
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  };
}

function bootGuided(): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.paneText = "ready";
  state.fullTerminal = false;
  state.agentChat = false;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, history: true };
  state.agents = [{
    paneId: "p1",
    agent: "herdr",
    hasAgent: true,
    status: "idle",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
  }];
  state.live = live();
  setRenderer(() => renderPane());
  renderPane();
}

function click(label: string): void {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.innerHTML.slice(0, 280)}`);
  el.click();
}

beforeAll(() => {
  setRenderer(() => renderPane());
});

afterEach(() => {
  guidedScrollController.dispose();
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  state.screen = "pane";
  state.live = null;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  app.replaceChildren();
});

describe("guided pane no longer overlays earlier output", () => {
  test("the live buffer has no 更早的输出 chip", () => {
    bootGuided();
    expect(app.querySelector(".term-more")).toBeNull();
    expect(app.querySelector(".term-back")).toBeNull();
    expect(app.querySelector(".term")).toBeTruthy();
    expect(app.querySelector(".full-terminal-scroll")).toBeTruthy();
    expect([...app.querySelectorAll(".full-terminal-scroll-btn")].map((el) => el.getAttribute("aria-label"))).toEqual([
      "鼠标滚轮向上",
      "上一页",
      "下一页",
      "鼠标滚轮向下",
    ]);
  });

  test("更早的输出 is a session-menu action when history is allowed", () => {
    bootGuided();
    click("这一屏");
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).toContain("更早的输出");
    expect(app.querySelector(".term-more")).toBeNull();
    expect(sheet?.querySelector(".sheet-head .sheet-close")).toBeTruthy();
    expect(sheet?.querySelector(".sheet-body")?.textContent).toContain("更早的输出");
    expect(sheet?.querySelector(".sheet-head")?.textContent).not.toContain("更早的输出");
  });

  test("the menu omits 更早的输出 when history is off", () => {
    bootGuided();
    state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
    click("这一屏");
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).not.toContain("更早的输出");
  });

  test("the menu action opens a history sheet, not an overlay on the live buffer", async () => {
    bootGuided();
    click("这一屏");
    const item = [...document.querySelectorAll("dialog.sheet button")].find((button) => button.textContent === "更早的输出");
    if (!(item instanceof HTMLButtonElement)) throw new Error("missing 更早的输出");
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const modal = document.querySelector("dialog.history-modal");
    expect(modal?.querySelector(".modal-title")?.textContent).toBe("更早的输出");
    expect(modal?.textContent).toContain("old");
    expect(app.querySelector(".term-more")).toBeNull();
    expect(app.querySelector(".term-back")).toBeNull();
  });
});

describe("control-mode TUI page rail", () => {
  test("outer arrows send mouse-wheel TerminalScroll instead of cursor keys", async () => {
    bootGuided();
    const scrolls: Array<Record<string, unknown>> = [];
    const keys: string[][] = [];
    const session = state.live!;
    state.live = {
      ...session,
      sendKeys: async (_paneId, batch) => {
        keys.push(batch);
      },
      terminalOpen: async (paneId, cols, rows) => ({
        operationId: "op_open",
        terminalId: "term_00000000000000000000000000000000",
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      }),
      terminalScroll: async (terminalId, sequence, direction, lines, source) => {
        scrolls.push({ terminalId, sequence, direction, lines, source });
      },
      terminalClose: async () => undefined,
    };
    const rail = [...app.querySelectorAll(".full-terminal-scroll-btn")] as HTMLButtonElement[];
    const wheelUp = rail.find((el) => el.getAttribute("aria-label") === "鼠标滚轮向上");
    const wheelDown = rail.find((el) => el.getAttribute("aria-label") === "鼠标滚轮向下");
    if (!wheelUp || !wheelDown) throw new Error("missing wheel buttons");
    const tap = () =>
      new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true, cancelable: true });
    wheelUp.dispatchEvent(tap());
    wheelDown.dispatchEvent(tap());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(scrolls).toEqual([
      { terminalId: "term_00000000000000000000000000000000", sequence: 1, direction: "up", lines: 3, source: "wheel" },
      { terminalId: "term_00000000000000000000000000000000", sequence: 2, direction: "down", lines: 3, source: "wheel" },
    ]);
    expect(keys).toEqual([]);
  });

  test("上一页 / 下一页 write CSI into the PTY, not SendKeys pageup", async () => {
    bootGuided();
    const texts: string[] = [];
    const keys: string[][] = [];
    const session = state.live!;
    state.live = {
      ...session,
      sendText: async (_paneId, text) => {
        texts.push(text);
      },
      sendKeys: async (_paneId, batch) => {
        keys.push(batch);
      },
      paneRead: async () => ({ text: state.paneText, hash: "h" }),
    };
    const rail = [...app.querySelectorAll(".full-terminal-scroll-btn")] as HTMLButtonElement[];
    const pageUp = rail.find((el) => el.getAttribute("aria-label") === "上一页");
    const pageDown = rail.find((el) => el.getAttribute("aria-label") === "下一页");
    if (!pageUp || !pageDown) throw new Error("missing page buttons");
    const tap = () =>
      new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true, cancelable: true });
    pageUp.dispatchEvent(tap());
    pageDown.dispatchEvent(tap());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(texts).toEqual(["\u001b[5~", "\u001b[6~"]);
    expect(keys).toEqual([]);
  });
});
