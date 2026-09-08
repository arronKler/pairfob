import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { app, state } from "../../state";
import { setRenderer } from "../../paint";
import { predictKeys, resetEcho, settleEcho } from "../session/echo";
import { guidedScrollController } from "../session/guided-scroll";
import { bindPaneRefresh } from "../../pane-refresh-request";
import { noteSnapshot } from "../session/unread";
import {
  bindPinch,
  bindTap,
  displayedTermModel,
  fillTerm,
  restoreTermScroll,
} from "../session/term";
import { paneModel } from "../session/model";
import { SessionRowBar } from "./session-rowbar";
import { SessionTerminal } from "./session-terminal";

beforeEach(resetBoardTestDOM);

const g = globalThis as unknown as Record<string, unknown>;
g.HTMLTextAreaElement = happy.HTMLTextAreaElement;
g.TouchEvent = happy.TouchEvent;
g.KeyboardEvent = happy.KeyboardEvent;
window.getSelection = () => ({ isCollapsed: true }) as Selection;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function pointer(type: string, target: EventTarget, x = 8, y = 8): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType: "mouse",
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
}

function touchOn(term: HTMLElement, type: string, distance: number): Event {
  const event = new happy.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: distance ? [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }] : [],
  });
  term.dispatchEvent(event as unknown as Event);
  return event;
}

function live(extra: Record<string, unknown> = {}) {
  return {
    history: async () => ({ items: [], next_cursor: null, truncated: false }),
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
    ...extra,
  };
}

function boot(text = "ready"): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.paneText = text;
  state.paneHash = "h0";
  state.fullTerminal = false;
  state.termSelect = false;
  state.termWrap = false;
  state.paneFollow = true;
  state.paneUnread = false;
  state.paneRow = null;
  state.composeDraft = "";
  state.live = live();
  setRenderer(() => {
    renderReact(createElement(Fragment, null, createElement(SessionTerminal), createElement(SessionRowBar)));
  });
  renderReact(createElement(Fragment, null, createElement(SessionTerminal), createElement(SessionRowBar)));
}

function paint(): void {
  renderReact(createElement(Fragment, null, createElement(SessionTerminal), createElement(SessionRowBar)));
}

afterEach(() => act(() => {
  guidedScrollController.dispose();
  resetEcho();
  bindPaneRefresh(async () => null);
  state.termSelect = false;
  displayedTermModel(paneModel());
  state.live = null;
  state.paneId = "";
  state.paneText = "";
  state.paneRow = null;
  state.paneFollow = true;
  state.paneUnread = false;
  state.termWrap = false;
  unmountReact();
  app.replaceChildren();
  setRenderer(() => {});
}));

describe("react guided terminal", () => {
  test("paints .term-wrap > .term > .term-inner > .term-line[data-row] without wrapping legacy builders", async () => {
    boot("hello\nworld");
    const wrap = app.querySelector(".term-wrap");
    const term = app.querySelector(".term");
    const inner = app.querySelector(".term-inner");
    const rows = [...app.querySelectorAll(".term-line")];
    expect(wrap?.contains(term!)).toBeTrue();
    expect(term?.contains(inner!)).toBeTrue();
    expect(term?.getAttribute("role")).toBe("log");
    expect(term?.parentElement).toBe(wrap);
    expect(rows.map((row) => row.getAttribute("data-row"))).toEqual(["0", "1"]);
    expect(rows[0]?.textContent).toContain("hello");
    expect(app.querySelector(".full-terminal-scroll")).toBeTruthy();
    expect([...app.querySelectorAll(".full-terminal-scroll-btn")].map((el) => el.getAttribute("aria-label"))).toEqual([
      "鼠标滚轮向上",
      "上一页",
      "下一页",
      "鼠标滚轮向下",
    ]);
    expect(wrap?.hasAttribute("data-react-session-terminal")).toBeTrue();
    const source = await Bun.file(new URL("./session-terminal.tsx", import.meta.url)).text();
    expect(source).not.toContain("termView(");
    expect(source).not.toContain("fillTerm(");
    expect(source).not.toContain("scrollRail(");
    expect(source).not.toContain("renderTerm(");
  });

  test("keeps the .term host across paints", () => {
    boot("hello");
    const term = app.querySelector(".term");
    const inner = app.querySelector(".term-inner");
    state.paneText = "hello\nnext";
    paint();
    expect(app.querySelector(".term")).toBe(term);
    expect(app.querySelector(".term-inner")).toBe(inner);
    expect(app.querySelectorAll(".term-line")).toHaveLength(2);
  });

  test("echo ghost sits on the last nonempty row and does not replace .term", () => {
    boot("$ ");
    const term = app.querySelector(".term");
    act(() => {
      predictKeys("p1", ["x"], "h0");
    });
    const ghost = app.querySelector(".term-ghost");
    expect(ghost?.textContent).toBe("x");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.className).toBe("term-ghost");
    expect(ghost?.closest(".term-line")?.getAttribute("data-row")).toBe("0");
    expect(app.querySelector(".term")).toBe(term);
    act(() => {
      settleEcho("p1", ["$ something else"], "h1");
    });
    expect(app.querySelector(".term-ghost")?.classList.contains("is-rollback")).toBeTrue();
  });

  test("selection freeze keeps displayed rows across a root remount", () => {
    boot("hello\nworld");
    const term = app.querySelector(".term");
    state.termSelect = true;
    paint();
    expect(term?.classList.contains("selecting")).toBeTrue();
    state.paneText = "CHANGED\nNOW";
    paint();
    expect(app.querySelector(".term")).toBe(term);
    expect([...app.querySelectorAll(".term-line")].map((row) => row.textContent)).toEqual(["hello", "world"]);
    unmountReact();
    paint();
    expect([...app.querySelectorAll(".term-line")].map((row) => row.textContent)).toEqual(["hello", "world"]);
    expect(app.textContent).not.toContain("CHANGED");
  });

  test("model refresh retains the React terminal host and rows container", () => {
    boot("hello");
    const inner = app.querySelector(".term-inner");
    const term = app.querySelector(".term") as HTMLElement;
    state.paneText = "should-not-vanilla-replace";
    act(() => {
      fillTerm(term, paneModel());
    });
    expect(app.querySelector(".term-inner")).toBe(inner);
    expect(app.querySelector(".term")).toBe(term);
    expect(app.textContent).toContain("should-not-vanilla-replace");
  });

  test("restoreTermScroll is host-identity guarded", () => {
    boot("hello\nworld\nmore");
    const term = app.querySelector(".term") as HTMLElement;
    Object.defineProperty(term, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(term, "clientHeight", { configurable: true, value: 80 });
    restoreTermScroll(term, { top: 40, left: 3, bottom: false });
    expect(term.scrollTop).toBe(40);
    expect(term.scrollLeft).toBe(3);
    restoreTermScroll(term, { top: 0, left: 0, bottom: true });
    expect(term.scrollTop).toBe(400);
    const other = document.createElement("div");
    other.className = "term";
    restoreTermScroll(other, { top: 9, left: 0, bottom: false });
    expect(other.scrollTop).toBe(0);
  });

  test("the jump chip follows unread state and travels to the bottom", async () => {
    boot("old");
    state.paneFollow = false;
    noteSnapshot("p1", ["old"], true);
    noteSnapshot("p1", ["old", "fresh"], false);
    state.paneUnread = true;
    paint();
    const jump = app.querySelector(".term-jump") as HTMLButtonElement;
    expect(jump.hidden).toBeFalse();
    expect(jump.getAttribute("aria-label")).toContain("新");
    const term = app.querySelector(".term") as HTMLElement;
    Object.defineProperty(term, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(term, "clientHeight", { configurable: true, value: 80 });
    act(() => {
      jump.click();
    });
    expect(state.paneFollow).toBeTrue();
    expect(app.querySelector(".term-jump")?.classList.contains("term-jump-out")).toBeTrue();
    await act(async () => {
      await wait(280);
    });
    expect((app.querySelector(".term-jump") as HTMLButtonElement).hidden).toBeTrue();
  });

  test("follow updates from the native scroll listener without replacing .term", () => {
    boot("ready");
    const term = app.querySelector(".term") as HTMLElement;
    Object.defineProperty(term, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(term, "clientHeight", { configurable: true, value: 80 });
    term.scrollTop = 0;
    state.paneFollow = true;
    act(() => {
      term.dispatchEvent(new happy.Event("scroll", { bubbles: true }));
    });
    expect(state.paneFollow).toBeFalse();
    expect(app.querySelector(".term")).toBe(term);
    term.scrollTop = 400;
    act(() => {
      term.dispatchEvent(new happy.Event("scroll", { bubbles: true }));
    });
    expect(state.paneFollow).toBeTrue();
  });
});

describe("react guided terminal gestures", () => {
  test("a zoomed page leaves pinch to the browser and a live pinch changes the type", () => {
    const viewport = { scale: 2 };
    boot("ready");
    const font = state.termFontPx;
    const term = app.querySelector<HTMLElement>(".term")!;
    const view = term.ownerDocument.defaultView!;
    const descriptor = Object.getOwnPropertyDescriptor(view, "visualViewport");
    Object.defineProperty(view, "visualViewport", { configurable: true, value: viewport });
    try {
      touchOn(term, "touchstart", 100);
      expect(touchOn(term, "touchmove", 80).defaultPrevented).toBeFalse();
      expect(state.termFontPx).toBe(font);
      viewport.scale = 1;
      touchOn(term, "touchstart", 100);
      expect(touchOn(term, "touchmove", 140).defaultPrevented).toBeTrue();
      expect(state.termFontPx).toBeGreaterThan(font);
    } finally {
      if (descriptor) Object.defineProperty(view, "visualViewport", descriptor);
      else Reflect.deleteProperty(view, "visualViewport");
      state.termFontPx = font;
    }
  });

  test("bindPinch cleanup ignores a later pinch", () => {
    const term = document.createElement("div");
    app.append(term);
    const font = state.termFontPx;
    const stop = bindPinch(term);
    stop();
    touchOn(term, "touchstart", 100);
    touchOn(term, "touchmove", 160);
    expect(state.termFontPx).toBe(font);
    term.remove();
  });

  test("bindTap hold is cancelled on dispose before the row bar opens", async () => {
    const term = document.createElement("div");
    const row = document.createElement("div");
    row.className = "term-line";
    row.dataset.row = "0";
    row.textContent = "hello";
    term.append(row);
    app.append(term);
    const opened: number[] = [];
    const stop = bindTap(term, (index) => opened.push(index));
    row.dispatchEvent(pointer("pointerdown", row));
    stop();
    await wait(500);
    expect(opened).toEqual([]);
    term.remove();
  });

  test("unmounting SessionTerminal cancels a pending row hold", async () => {
    const opened: number[] = [];
    boot("hello");
    renderReact(createElement(SessionTerminal, { onRow: (index) => opened.push(index) }));
    const row = app.querySelector(".term-line")!;
    row.dispatchEvent(pointer("pointerdown", row));
    unmountReact();
    await wait(500);
    expect(opened).toEqual([]);
  });

  test("a short tap focuses compose", () => {
    unmountReact();
    state.composeFocused = false;
    const term = document.createElement("div");
    term.className = "term";
    const row = document.createElement("div");
    row.className = "term-line";
    row.dataset.row = "0";
    row.textContent = "hello";
    term.append(row);
    const field = document.createElement("textarea");
    const form = document.createElement("form");
    form.className = "dock-form";
    form.append(field);
    const focused: EventTarget[] = [];
    field.focus = ((opts?: FocusOptions) => {
      focused.push(field);
      state.composeFocused = true;
      void opts;
    }) as typeof field.focus;
    app.replaceChildren(term, form);
    const stop = bindTap(term, () => {
      throw new Error("short tap must not open the row bar");
    });
    try {
      row.dispatchEvent(pointer("pointerdown", row));
      row.dispatchEvent(pointer("pointerup", row));
      expect(focused).toEqual([field]);
      expect(state.composeFocused).toBeTrue();
    } finally {
      stop();
    }
  });
});
