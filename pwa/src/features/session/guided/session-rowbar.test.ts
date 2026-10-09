import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../../../lib/i18n";
import { discardEmptyPaneRow, openRow, placeRowBubble } from "./rowbar";
import { appRoot } from "../../../app/dom-root";
import { paneModel } from "./pane-model";
import { ROW_COPIED_MS, SessionRowBar } from "./session-rowbar";
import { sessionStore } from "../session-store";
import { setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import {
  applyPaneRead, paneRow, resetPaneView, selectPane, setPaneRow, setTermSelect, termSelect,
} from "../session-store";
import { composeDraft, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from
  "../compose-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { resetDashboard } from "../../dashboard/catalog-store";
import { setOperationBusy } from "../../operations/capabilities-store";
import { clearNotice, visibleNotice } from "../../../app/notices-store";
import { expectSameNode } from "../../../../test-support/node-identity";

// Isolated component boundary: this suite mounts ONLY <SessionRowBar/> into a
// private fixture root it creates and disposes itself — no App host, no global
// screen bridge, no paint alias. Domain actions publish their normal snapshots;
// act flushes the component's store subscriptions. This is deliberately not an
// App integration test; navigation fixtures mount the real App elsewhere.
let root: Root | null = null;
let container: HTMLDivElement | null = null;

// The bar is a leaf: its parent re-renders on session-domain publications. The
// harness subscribes the fixture-owned root the same way, so a domain action
// (openRow/quote/copy/select) repaints the bar inside act with no paint host.
function RowBarHarness() {
  useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get);
  return createElement(SessionRowBar);
}

function paint(): void {
  act(() => { root?.render(createElement(RowBarHarness)); });
}

function click(label: string): HTMLButtonElement {
  const el = [...(container!.querySelectorAll("button"))].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  act(() => { el.click(); });
  return el;
}

const rect = (top: number, bottom: number) =>
  ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top }) as DOMRect;

/** Lay row 0 out inside the terminal, so the bubble opened for it is on screen. */
function showRow(): { term: HTMLElement; row: HTMLElement } {
  const term = document.createElement("div");
  term.className = "term";
  const row = document.createElement("div");
  row.className = "term-line";
  row.dataset.row = "0";
  term.append(row);
  term.getBoundingClientRect = () => rect(100, 600);
  row.getBoundingClientRect = () => rect(200, 218);
  appRoot().replaceChildren(term);
  return { term, row };
}

function escape(target: Node, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function boot(text = "open /tmp/demo/readme.md"): void {
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    resetPaneView();
    applyPaneRead(text, "h0");
    setPaneRow(null);
    setComposeDraft("");
    setComposeLive(false);
    clearNotice();
    attachLiveSession(null);
    resetDashboard();
  });
  paint();
}

let clipboard: PropertyDescriptor | undefined;
beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetPaneView();
    setComposeIME(false);
    setComposeFocused(false);
    setComposeLive(false);
    setOperationBusy(false);
    clearNotice();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
});

afterEach(async () => {
  await act(async () => { await Promise.resolve(); });
  act(() => { root?.unmount(); });
  root = null;
  container?.remove();
  container = null;
  act(() => {
    setTermSelect(false);
    setPaneRow(null);
    setComposeDraft("");
    clearNotice();
  });
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("react session row bar", () => {
  test("render does not clear an empty selected row; the controller does", () => {
    boot("   ");
    act(() => setPaneRow(0));
    paint();
    expect(paneRow()).toBe(0);
    expect(container!.querySelector(".row-bubble")).toBeNull();
    let discarded: boolean;
    act(() => { discarded = discardEmptyPaneRow(paneModel()); });
    expect(discarded!).toBeTrue();
    expect(paneRow()).toBeNull();
  });

  test("openRow rejects an empty line and the bubble offers copy, path, quote and select", () => {
    boot("hello from /tmp/demo/app.ts");
    act(() => { openRow(0); });
    const bar = container!.querySelector(".row-bubble");
    expect(bar?.getAttribute("role")).toBe("toolbar");
    expect(bar?.hasAttribute("data-react-session-rowbar")).toBeTrue();
    const labels = [...container!.querySelectorAll(".row-act")].map((el) => el.textContent);
    expect(labels).toEqual(["复制", "复制路径", "引用", "选择"]);
    const pathButton = [...container!.querySelectorAll(".row-act")][1];
    expect(pathButton.getAttribute("aria-label")).toBe("复制路径 /tmp/demo/app.ts");
    act(() => applyPaneRead("   ", "h-spaces"));
    let opened: ReturnType<typeof openRow>;
    act(() => { opened = openRow(0); });
    expect(opened).toBeUndefined();
    expect(paneRow()).toBeNull();
  });

  test("no path means no path action", () => {
    boot("plain words only");
    act(() => { openRow(0); });
    const labels = [...container!.querySelectorAll(".row-act")].map((el) => el.textContent);
    expect(labels).toEqual(["复制", "引用", "选择"]);
  });

  test("a second tap on the same row closes it", () => {
    boot("same row");
    act(() => { openRow(0); });
    expect(paneRow()).toBe(0);
    act(() => { openRow(0); });
    expect(paneRow()).toBeNull();
    expect(container!.querySelector(".row-bubble")).toBeNull();
  });

  test("quote inserts into compose and select enters selection mode", () => {
    boot("quoted line");
    act(() => { openRow(0); });
    click("引用");
    expect(composeDraft()).toContain("quoted line");
    expect(paneRow()).toBeNull();
    act(() => { openRow(0); });
    click("选择");
    expect(termSelect()).toBeTrue();
    expect(paneRow()).toBeNull();
  });

  test("a tap outside the bubble and the terminal closes it; inside does not", () => {
    boot("hello");
    const term = document.createElement("div");
    term.className = "term";
    const outside = document.createElement("button");
    appRoot().replaceChildren(term, outside);
    act(() => { openRow(0); });
    const bubble = container!.querySelector(".row-bubble")!;
    act(() => { bubble.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    act(() => { term.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(paneRow()).toBe(0);
    act(() => { outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(paneRow()).toBeNull();
    appRoot().replaceChildren();
  });

  test("Escape closes the bubble and goes no further; the next one is the session's", () => {
    boot("hello");
    showRow();
    act(() => { openRow(0); });
    const seen: boolean[] = [];
    const later = (event: Event) => { seen.push(event.defaultPrevented); };
    document.addEventListener("keydown", later);
    try {
      let first: KeyboardEvent;
      act(() => { first = escape(document.body); });
      expect(paneRow()).toBeNull();
      expect(container!.querySelector(".row-bubble")).toBeNull();
      expect(first!.defaultPrevented).toBeTrue();
      // Neither the compose field nor the page-level pane keys saw it.
      expect(seen).toEqual([]);
      let second: KeyboardEvent;
      act(() => { second = escape(document.body); });
      expect(second!.defaultPrevented).toBeFalse();
      expect(seen).toEqual([false]);
    } finally {
      document.removeEventListener("keydown", later);
      appRoot().replaceChildren();
    }
  });

  test("Escape is left alone for a chord, a composition, a dialog and a bubble that is off screen", () => {
    boot("hello");
    const { row } = showRow();
    act(() => { openRow(0); });
    const kept = (init: KeyboardEventInit = {}): boolean => {
      let event: KeyboardEvent;
      act(() => { event = escape(document.body, init); });
      return paneRow() === 0 && !event!.defaultPrevented;
    };
    try {
      expect(kept({ ctrlKey: true })).toBeTrue();
      expect(kept({ isComposing: true })).toBeTrue();
      act(() => setComposeIME(true));
      expect(kept()).toBeTrue();
      act(() => setComposeIME(false));
      const dialog = document.createElement("dialog");
      dialog.setAttribute("open", "");
      document.body.append(dialog);
      expect(kept()).toBeTrue();
      dialog.remove();
      // Output pushed the picked row out of view: nothing is on screen to dismiss.
      row.getBoundingClientRect = () => rect(700, 718);
      paint();
      expect(container!.querySelector(".row-bubble")!.hasAttribute("data-offscreen")).toBeTrue();
      expect(kept()).toBeTrue();
    } finally {
      appRoot().replaceChildren();
    }
  });

  test("the bubble sits above its row, or below it when the row is at the top", () => {
    const stage = document.createElement("div");
    const term = document.createElement("div");
    term.className = "term";
    const row = document.createElement("div");
    row.className = "term-line";
    row.dataset.row = "3";
    term.append(row);
    const bubble = document.createElement("div");
    stage.append(term, bubble);
    appRoot().replaceChildren(stage);
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top }) as DOMRect;
    let rowTop = 200;
    stage.getBoundingClientRect = () => rect(100, 600);
    term.getBoundingClientRect = () => rect(100, 600);
    row.getBoundingClientRect = () => rect(rowTop, rowTop + 18);
    Object.defineProperty(bubble, "offsetHeight", { configurable: true, value: 46 });
    placeRowBubble(bubble, 3);
    expect(bubble.dataset.side).toBe("above");
    expect(bubble.style.top).toBe(`${200 - 100 - 6 - 46}px`);
    rowTop = 110;
    placeRowBubble(bubble, 3);
    expect(bubble.dataset.side).toBe("below");
    expect(bubble.style.top).toBe(`${128 - 100 + 6}px`);
    rowTop = 700;
    placeRowBubble(bubble, 3);
    expect(bubble.hasAttribute("data-offscreen")).toBeTrue();
    appRoot().replaceChildren();
  });

  test("opened by a mouse beside the list it stands at the pointer, inside the pane; a finger keeps the bar", () => {
    const stage = document.createElement("div");
    const term = document.createElement("div");
    term.className = "term";
    const row = document.createElement("div");
    row.className = "term-line";
    row.dataset.row = "0";
    const bubble = document.createElement("div");
    term.append(row);
    stage.append(term, bubble);
    appRoot().replaceChildren(stage);
    // A pane from 400 to 1300, the stage it floats in starting at 300.
    const box = (left: number, right: number, top: number, bottom: number) =>
      ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;
    stage.getBoundingClientRect = () => box(300, 1320, 100, 800);
    term.getBoundingClientRect = () => box(400, 1300, 100, 800);
    row.getBoundingClientRect = () => box(412, 1288, 200, 220);
    Object.defineProperty(bubble, "offsetHeight", { configurable: true, value: 38 });
    Object.defineProperty(bubble, "offsetWidth", { configurable: true, value: 240 });
    boot("src/app.ts +12 -4");
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    try {
      // Centred on the press.
      act(() => { openRow(0, { x: 828, mouse: true }); });
      placeRowBubble(bubble, 0);
      expect(bubble.dataset.anchor).toBe("pointer");
      expect(bubble.style.left).toBe(`${828 - 120 - 300}px`);
      expect(bubble.style.top).toBe(`${200 - 100 - 6 - 38}px`);
      // Near either edge it stays 8px inside the pane.
      act(() => { openRow(0); openRow(0, { x: 404, mouse: true }); });
      placeRowBubble(bubble, 0);
      expect(bubble.style.left).toBe(`${408 - 300}px`);
      act(() => { openRow(0); openRow(0, { x: 1296, mouse: true }); });
      placeRowBubble(bubble, 0);
      expect(bubble.style.left).toBe(`${1300 - 8 - 240 - 300}px`);
      // A finger on the same wide screen: the bar across the pane, as it was.
      act(() => { openRow(0); openRow(0, { x: 828, mouse: false }); });
      placeRowBubble(bubble, 0);
      expect(bubble.dataset.anchor).toBeUndefined();
      expect(bubble.style.left).toBe("");
      // And a mouse over a phone-width window is the phone session.
      happy.happyDOM.setWindowSize({ width: 390, height: 844 });
      act(() => { openRow(0); openRow(0, { x: 200, mouse: true }); });
      placeRowBubble(bubble, 0);
      expect(bubble.dataset.anchor).toBeUndefined();
    } finally {
      happy.happyDOM.setWindowSize({ width: 390, height: 844 });
      act(() => { setPaneRow(null); });
      appRoot().replaceChildren();
    }
  });

  test("controller still normalizes empty selection without a React render", () => {
    boot("hello");
    act(() => {
      setPaneRow(0);
      applyPaneRead("   ", "h-spaces");
    });
    let discarded: boolean;
    act(() => { discarded = discardEmptyPaneRow(paneModel()); });
    expect(discarded!).toBeTrue();
    expect(paneRow()).toBeNull();
  });

  test("a copy is confirmed on the pressed action, raises no banner, and the bar then closes by itself", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => written.push(text) },
    });
    boot("copy me");
    act(() => { openRow(0); });
    const copy = click("复制");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(written).toEqual(["copy me"]);
    // The banner used to push the buffer down under the next press.
    expect(visibleNotice()).toBeNull();
    expect(paneRow()).toBe(0);
    expectSameNode(container!.querySelector(".row-act"), copy);
    expect([copy.textContent, copy.getAttribute("aria-label"), "copied" in copy.dataset]).toEqual(["已复制", "已复制这一行。", true]);
    // Pressing again copies again and starts the confirmation over.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ROW_COPIED_MS - 300)); });
    click("已复制");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(written).toEqual(["copy me", "copy me"]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ROW_COPIED_MS - 300)); });
    expect(paneRow()).toBe(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(paneRow()).toBeNull();
    expect(container!.querySelector(".row-bubble")).toBeNull();
  });

  test("a row picked while another says copied keeps its bubble, with the actions as they were", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => written.push(text) },
    });
    boot("first line\nsecond line");
    act(() => { openRow(0); });
    click("复制");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { openRow(1); });
    expect(container!.querySelector(".row-act")?.textContent).toBe("复制");
    click("复制");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(written).toEqual(["first line", "second line"]);
    // The first copy's wait ends without closing the second row's bubble.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ROW_COPIED_MS - 200)); });
    expect(paneRow()).toBe(1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(paneRow()).toBeNull();
  });

  test("a refused copy closes the bar under its reason", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("denied"); } },
    });
    boot("copy me");
    act(() => { openRow(0); });
    click("复制");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleNotice()?.tone).toBe("error");
    expect(paneRow()).toBeNull();
  });
});
