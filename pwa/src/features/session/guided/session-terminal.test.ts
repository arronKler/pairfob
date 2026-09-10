import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { ScalarPreferenceState } from "../../../../test-support/preferences-scalar-restore";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { setPhase } from "../../connection/connection-store";
import { applyPaneRead, paneFollow, selectPane, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect } from "../session-store";
import { composeFocused, setComposeDraft, setComposeFocused } from "../compose-store";
import { setTermFontPx, setTermWrap, termFontPx } from "../../settings/preferences-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { predictKeys, resetEcho, settleEcho } from "./echo";
import { guidedScrollController } from "./guided-scroll";
import { bindPaneRefresh } from "../../connection/refresh-request";
import { noteSnapshot } from "./unread";
import {
  bindPinch,
  bindTap,
  displayedTermModel,
  fillTerm,
  restoreTermScroll,
} from "./term";
import { paneModel } from "./pane-model";
import { SessionRowBar } from "./session-rowbar";
import { SessionTerminal } from "./session-terminal";

beforeEach(async () => {
  await resetBoardTestDOM();
  scalarPrefState.capture();
});

const g = globalThis as unknown as Record<string, unknown>;
g.HTMLTextAreaElement = happy.HTMLTextAreaElement;
g.TouchEvent = happy.TouchEvent;
g.KeyboardEvent = happy.KeyboardEvent;
window.getSelection = () => ({ isCollapsed: true }) as Selection;

// boot()/afterEach call the persisting preference setters (setTermWrap), so
// capture canonical+raw pre-images before any of them runs and restore after
// own teardown to avoid leaking a reset's raw write.
const scalarPrefState = new ScalarPreferenceState();

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
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  applyPaneRead(text, "h0");
  setFullTerminal(false);
  setTermSelect(false);
  setTermWrap(false);
  setPaneFollow(true);
  setPaneUnread(false);
  setPaneRow(null);
  setComposeDraft("");
  attachLiveSession(live());
  renderReact(createElement(Fragment, null, createElement(SessionTerminal), createElement(SessionRowBar)));
}

function paint(): void {
  renderReact(createElement(Fragment, null, createElement(SessionTerminal), createElement(SessionRowBar)));
}

afterEach(() => act(() => {
  guidedScrollController.dispose();
  resetEcho();
  bindPaneRefresh(async () => null);
  setTermSelect(false);
  displayedTermModel(paneModel());
  attachLiveSession(null);
  selectPane("");
  applyPaneRead("", "");
  setPaneRow(null);
  setPaneFollow(true);
  setPaneUnread(false);
  setTermWrap(false);
  unmountReact();
  appRoot().replaceChildren();
  scalarPrefState.restore();
}));

describe("react guided terminal", () => {
  test("paints .term-wrap > .term > .term-inner > .term-line[data-row] without wrapping legacy builders", async () => {
    boot("hello\nworld");
    const wrap = appRoot().querySelector(".term-wrap");
    const term = appRoot().querySelector(".term");
    const inner = appRoot().querySelector(".term-inner");
    const rows = [...appRoot().querySelectorAll(".term-line")];
    expect(wrap?.contains(term!)).toBeTrue();
    expect(term?.contains(inner!)).toBeTrue();
    expect(term?.getAttribute("role")).toBe("log");
    expect(term?.parentElement).toBe(wrap);
    expect(rows.map((row) => row.getAttribute("data-row"))).toEqual(["0", "1"]);
    expect(rows[0]?.textContent).toContain("hello");
    expect(appRoot().querySelector(".full-terminal-scroll")).toBeTruthy();
    expect([...appRoot().querySelectorAll(".full-terminal-scroll-btn")].map((el) => el.getAttribute("aria-label"))).toEqual([
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
    const term = appRoot().querySelector(".term");
    const inner = appRoot().querySelector(".term-inner");
    applyPaneRead("hello\nnext", "h0");
    paint();
    expect(appRoot().querySelector(".term")).toBe(term);
    expect(appRoot().querySelector(".term-inner")).toBe(inner);
    expect(appRoot().querySelectorAll(".term-line")).toHaveLength(2);
  });

  test("echo ghost sits on the last nonempty row and does not replace .term", () => {
    boot("$ ");
    const term = appRoot().querySelector(".term");
    act(() => {
      predictKeys("p1", ["x"], "h0");
    });
    const ghost = appRoot().querySelector(".term-ghost");
    expect(ghost?.textContent).toBe("x");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.className).toBe("term-ghost");
    expect(ghost?.closest(".term-line")?.getAttribute("data-row")).toBe("0");
    expect(appRoot().querySelector(".term")).toBe(term);
    act(() => {
      settleEcho("p1", ["$ something else"], "h1");
    });
    expect(appRoot().querySelector(".term-ghost")?.classList.contains("is-rollback")).toBeTrue();
  });

  test("selection freeze keeps displayed rows across a root remount", () => {
    boot("hello\nworld");
    const term = appRoot().querySelector(".term");
    setTermSelect(true);
    paint();
    expect(term?.classList.contains("selecting")).toBeTrue();
    applyPaneRead("CHANGED\nNOW", "h0");
    paint();
    expect(appRoot().querySelector(".term")).toBe(term);
    expect([...appRoot().querySelectorAll(".term-line")].map((row) => row.textContent)).toEqual(["hello", "world"]);
    unmountReact();
    paint();
    expect([...appRoot().querySelectorAll(".term-line")].map((row) => row.textContent)).toEqual(["hello", "world"]);
    expect(appRoot().textContent).not.toContain("CHANGED");
  });

  test("model refresh retains the React terminal host and rows container", () => {
    boot("hello");
    const inner = appRoot().querySelector(".term-inner");
    const term = appRoot().querySelector(".term") as HTMLElement;
    applyPaneRead("should-not-vanilla-replace", "h0");
    act(() => {
      fillTerm(term, paneModel());
    });
    expect(appRoot().querySelector(".term-inner")).toBe(inner);
    expect(appRoot().querySelector(".term")).toBe(term);
    expect(appRoot().textContent).toContain("should-not-vanilla-replace");
  });

  test("restoreTermScroll is host-identity guarded", () => {
    boot("hello\nworld\nmore");
    const term = appRoot().querySelector(".term") as HTMLElement;
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
    setPaneFollow(false);
    noteSnapshot("p1", ["old"], true);
    noteSnapshot("p1", ["old", "fresh"], false);
    setPaneUnread(true);
    paint();
    const jump = appRoot().querySelector(".term-jump") as HTMLButtonElement;
    expect(jump.hidden).toBeFalse();
    expect(jump.getAttribute("aria-label")).toContain("新");
    const term = appRoot().querySelector(".term") as HTMLElement;
    Object.defineProperty(term, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(term, "clientHeight", { configurable: true, value: 80 });
    act(() => {
      jump.click();
    });
    expect(paneFollow()).toBeTrue();
    expect(appRoot().querySelector(".term-jump")?.classList.contains("term-jump-out")).toBeTrue();
    await act(async () => {
      await wait(280);
    });
    expect((appRoot().querySelector(".term-jump") as HTMLButtonElement).hidden).toBeTrue();
  });

  test("follow updates from the native scroll listener without replacing .term", () => {
    boot("ready");
    const term = appRoot().querySelector(".term") as HTMLElement;
    Object.defineProperty(term, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(term, "clientHeight", { configurable: true, value: 80 });
    term.scrollTop = 0;
    setPaneFollow(true);
    act(() => {
      term.dispatchEvent(new happy.Event("scroll", { bubbles: true }));
    });
    expect(paneFollow()).toBeFalse();
    expect(appRoot().querySelector(".term")).toBe(term);
    term.scrollTop = 400;
    act(() => {
      term.dispatchEvent(new happy.Event("scroll", { bubbles: true }));
    });
    expect(paneFollow()).toBeTrue();
  });
});

describe("react guided terminal gestures", () => {
  test("a zoomed page leaves pinch to the browser and a live pinch changes the type", () => {
    const viewport = { scale: 2 };
    boot("ready");
    const font = termFontPx();
    const term = appRoot().querySelector<HTMLElement>(".term")!;
    const view = term.ownerDocument.defaultView!;
    const descriptor = Object.getOwnPropertyDescriptor(view, "visualViewport");
    Object.defineProperty(view, "visualViewport", { configurable: true, value: viewport });
    try {
      touchOn(term, "touchstart", 100);
      expect(touchOn(term, "touchmove", 80).defaultPrevented).toBeFalse();
      expect(termFontPx()).toBe(font);
      viewport.scale = 1;
      touchOn(term, "touchstart", 100);
      expect(touchOn(term, "touchmove", 140).defaultPrevented).toBeTrue();
      expect(termFontPx()).toBeGreaterThan(font);
    } finally {
      if (descriptor) Object.defineProperty(view, "visualViewport", descriptor);
      else Reflect.deleteProperty(view, "visualViewport");
      setTermFontPx(font);
    }
  });

  test("bindPinch cleanup ignores a later pinch", () => {
    const term = document.createElement("div");
    appRoot().append(term);
    const font = termFontPx();
    const stop = bindPinch(term);
    stop();
    touchOn(term, "touchstart", 100);
    touchOn(term, "touchmove", 160);
    expect(termFontPx()).toBe(font);
    term.remove();
  });

  test("bindTap hold is cancelled on dispose before the row bar opens", async () => {
    const term = document.createElement("div");
    const row = document.createElement("div");
    row.className = "term-line";
    row.dataset.row = "0";
    row.textContent = "hello";
    term.append(row);
    appRoot().append(term);
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
    const row = appRoot().querySelector(".term-line")!;
    row.dispatchEvent(pointer("pointerdown", row));
    unmountReact();
    await wait(500);
    expect(opened).toEqual([]);
  });

  test("a short tap focuses compose", () => {
    unmountReact();
    setComposeFocused(false);
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
      setComposeFocused(true);
      void opts;
    }) as typeof field.focus;
    appRoot().replaceChildren(term, form);
    const stop = bindTap(term, () => {
      throw new Error("short tap must not open the row bar");
    });
    try {
      row.dispatchEvent(pointer("pointerdown", row));
      row.dispatchEvent(pointer("pointerup", row));
      expect(focused).toEqual([field]);
      expect(composeFocused()).toBeTrue();
    } finally {
      stop();
    }
  });
});
