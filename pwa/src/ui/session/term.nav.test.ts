import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, beforeAll, describe, expect, test } from "bun:test";

const { app, state } = await import("../../state.ts");
const { setRenderer } = await import("../../paint.ts");
const { renderPane: paintPane } = await import("../pane.ts");
const { leaveReactScreen } = await import("../react/root");
const renderPane = () => act(paintPane);
beforeEach(resetBoardTestDOM);
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
  act(() => el.click());
}

beforeAll(() => {
  setRenderer(() => renderPane());
});

afterEach(() => {
  guidedScrollController.dispose();
  closeTestDialogs();
  state.screen = "pane";
  state.live = null;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  act(leaveReactScreen);
  app.replaceChildren();
});

describe("guided pane no longer overlays earlier output", () => {
  test("a zoomed Control buffer leaves pinch to the browser and preserves its font", () => {
    const viewport = { scale: 2 };
    bootGuided();
    const font = state.termFontPx;
    const term = app.querySelector<HTMLElement>(".term")!;
    const pageWindow = term.ownerDocument.defaultView!;
    const previousViewport = Object.getOwnPropertyDescriptor(pageWindow, "visualViewport");
    Object.defineProperty(pageWindow, "visualViewport", { configurable: true, value: viewport });
    const touch = (type: string, distance: number) => {
      const event = new happy.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }] });
      term.dispatchEvent(event as unknown as Event);
      return event;
    };
    try {
      touch("touchstart", 100);
      expect(touch("touchmove", 80).defaultPrevented).toBeFalse();
      viewport.scale = 1;
      expect(touch("touchmove", 50).defaultPrevented).toBeFalse();
      expect(state.termFontPx).toBe(font);
      touch("touchend", 0);
      touch("touchstart", 100);
      expect(touch("touchmove", 140).defaultPrevented).toBeTrue();
      expect(state.termFontPx).toBeGreaterThan(font);
    } finally {
      if (previousViewport) Object.defineProperty(pageWindow, "visualViewport", previousViewport);
      else Reflect.deleteProperty(pageWindow, "visualViewport");
      state.termFontPx = font;
    }
  });

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

  test("会话操作 has no 更早的输出 even when history is allowed", () => {
    bootGuided();
    click("会话操作");
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).not.toContain("更早的输出");
    expect(document.querySelector("dialog.history-modal")).toBeNull();
    expect(app.querySelector(".term-more")).toBeNull();
  });
});

describe("interrupt while unverifiable", () => {
  test("a working pane hides Stop after a disconnect or failed GetConfig", () => {
    bootGuided();
    state.agents[0].status = "working";
    state.runtimeKind = "herdr";
    renderPane();
    expect(app.querySelector(".icon-stop")).not.toBeNull();

    state.live = { ...live(), isConnected: () => false };
    renderPane();
    expect(app.querySelector(".icon-stop")).toBeNull();
    expect(app.querySelector(".chrome-meta-text")?.textContent).toContain("未知");

    state.live = live();
    state.runtimeKind = "";
    renderPane();
    expect(app.querySelector(".icon-stop")).toBeNull();
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
    await act(async () => {
      wheelUp.dispatchEvent(tap());
      wheelDown.dispatchEvent(tap());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

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
    await act(async () => {
      pageUp.dispatchEvent(tap());
      pageDown.dispatchEvent(tap());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(texts).toEqual(["\u001b[5~", "\u001b[6~"]);
    expect(keys).toEqual([]);
  });
});
