import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import type { LiveSession } from "../../../lib/protocol/client";
import { attachLiveSession } from "../../computers/catalog-store";
import { setPhase } from "../../connection/connection-store";
import { bindPaneRefresh } from "../../connection/refresh-request";
import { bindHostScroll } from "../full-terminal/full-terminal-scroll";
import { setComposeDraft, setComposeIME, setComposeLive } from "../compose-store";
import { applyPaneRead, paneRow, selectPane, setFullTerminal, setPaneRow, setTermSelect } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";
import { handlePaneKey } from "./compose";
import { dropQueuedKeys, flushKeys } from "./keys";
import { paneModel } from "./pane-model";
import { bindDragSelection, bindTap, displayedTermModel, selectedTermText, termDragSelecting, termHasSelection } from "./term";

/**
 * Selecting text in the guided buffer with a mouse, beside the list: a drag is
 * the browser's own selection, a click that did not move is still the row
 * gesture, and neither the remote scroll nor Ctrl+C may fight the selection.
 */
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function pointer(type: string, pointerType: "mouse" | "touch", x = 8, y = 8): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1, isPrimary: true, pointerType, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true,
  });
}

function buffer() {
  const term = document.createElement("div");
  term.className = "term";
  const row = document.createElement("div");
  row.className = "term-line";
  row.dataset.row = "0";
  row.textContent = "hello";
  term.append(row);
  appRoot().replaceChildren(term);
  return { term, row };
}

/** A document selection the test moves; `selectionchange` tells the page it moved. */
function selection(doc: Document) {
  let nodes: { anchor: Node | null; focus: Node | null } = { anchor: null, focus: null };
  const native = doc.getSelection;
  let cleared = 0;
  doc.getSelection = (() => ({
    get isCollapsed() { return nodes.anchor === null; },
    get anchorNode() { return nodes.anchor; },
    get focusNode() { return nodes.focus; },
    removeAllRanges() { cleared += 1; nodes = { anchor: null, focus: null }; },
  })) as unknown as typeof doc.getSelection;
  return {
    select(anchor: Node | null, focus: Node | null = anchor) {
      nodes = { anchor, focus };
      doc.dispatchEvent(new happy.Event("selectionchange") as unknown as Event);
    },
    cleared: () => cleared,
    restore() { doc.getSelection = native; },
  };
}

let restorePointer: (() => void) | null = null;
let restoreSelection: (() => void) | null = null;
let restorePlatform: (() => void) | null = null;
let sentKeys: string[][] = [];
let sentText: string[] = [];

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize(DESK);
  // A range another suite left in the shared realm would read as a drag here.
  window.getSelection()?.removeAllRanges();
  sentKeys = [];
  sentText = [];
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  applyPaneRead("hello", "h0");
  setFullTerminal(false);
  setTermSelect(false);
  setComposeLive(false);
  setComposeIME(false);
  setComposeDraft("");
  bindPaneRefresh(async () => null);
  attachLiveSession({
    sendKeys: async (_paneId: string, keys: string[]) => { sentKeys.push(keys); },
    sendText: async (_paneId: string, text: string) => { sentText.push(text); },
    isConnected: () => true,
  } as unknown as LiveSession);
});

afterEach(() => {
  restorePointer?.();
  restorePointer = null;
  restoreSelection?.();
  restoreSelection = null;
  restorePlatform?.();
  restorePlatform = null;
  dropQueuedKeys();
  setTermSelect(false);
  displayedTermModel(paneModel());
  attachLiveSession(null);
  selectPane("");
  applyPaneRead("", "");
  setScreen("home");
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize(PHONE);
});

describe("row gestures by pointer", () => {
  test("a mouse click that did not move still opens the row; a long press selects nothing", async () => {
    const { term, row } = buffer();
    const opened: number[] = [];
    const held: number[] = [];
    const stop = bindTap(term, (index) => opened.push(index), { onHold: (index) => held.push(index) });
    try {
      row.dispatchEvent(pointer("pointerdown", "mouse"));
      row.dispatchEvent(pointer("pointerup", "mouse"));
      expect(opened).toEqual([0]);

      // Pressing and waiting is how a slow drag starts, not a request for select mode.
      row.dispatchEvent(pointer("pointerdown", "mouse"));
      await wait(480);
      row.dispatchEvent(pointer("pointerup", "mouse"));
      expect(held).toEqual([]);
      expect(opened).toEqual([0]);
    } finally {
      stop();
    }
  });

  test("a drag is not a click", () => {
    const { term, row } = buffer();
    const opened: number[] = [];
    const stop = bindTap(term, (index) => opened.push(index));
    try {
      row.dispatchEvent(pointer("pointerdown", "mouse"));
      row.dispatchEvent(pointer("pointermove", "mouse", 80, 8));
      row.dispatchEvent(pointer("pointerup", "mouse", 80, 8));
      expect(opened).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a finger on the same wide layout still holds to enter selection", async () => {
    const { term, row } = buffer();
    const held: number[] = [];
    const stop = bindTap(term, () => undefined, { onHold: (index) => held.push(index) });
    try {
      row.dispatchEvent(pointer("pointerdown", "touch"));
      await wait(480);
      expect(held).toEqual([0]);
    } finally {
      stop();
    }
  });

  test("a mouse at phone width keeps the hold it always had", async () => {
    happy.happyDOM.setWindowSize(PHONE);
    const { term, row } = buffer();
    const held: number[] = [];
    const stop = bindTap(term, () => undefined, { onHold: (index) => held.push(index) });
    try {
      row.dispatchEvent(pointer("pointerdown", "mouse"));
      await wait(480);
      expect(held).toEqual([0]);
    } finally {
      stop();
    }
  });

  test("a pointer type left to the browser never pages the agent; the others still do", () => {
    const { term } = buffer();
    const scrolled: string[] = [];
    const stop = bindHostScroll(term, (direction) => scrolled.push(direction), () => undefined, {
      grabTouch: false, tapAsClick: false, capturePan: () => true, pansWith: (type) => type !== "mouse",
    });
    try {
      term.dispatchEvent(pointer("pointerdown", "mouse", 8, 8));
      term.dispatchEvent(pointer("pointermove", "mouse", 8, 120));
      term.dispatchEvent(pointer("pointerup", "mouse", 8, 120));
      expect(scrolled).toEqual([]);

      term.dispatchEvent(pointer("pointerdown", "touch", 8, 8));
      term.dispatchEvent(pointer("pointermove", "touch", 8, 120));
      term.dispatchEvent(pointer("pointerup", "touch", 8, 120));
      expect(scrolled).toEqual(["up"]);
    } finally {
      stop();
    }
  });
});

describe("a mouse selection holds the rows it is in", () => {
  test("rows freeze while text in the buffer is selected and catch up when it goes", () => {
    const { term, row } = buffer();
    const picked = selection(document);
    restoreSelection = picked.restore;
    const stop = bindDragSelection(term);
    try {
      expect(termDragSelecting()).toBeFalse();
      const before = displayedTermModel(paneModel());

      picked.select(row.firstChild);
      expect(termHasSelection()).toBeTrue();
      expect(termDragSelecting()).toBeTrue();
      // A snapshot that arrives mid-selection must not replace the row nodes.
      applyPaneRead("hello\nmore output", "h1");
      expect(displayedTermModel(paneModel()).texts).toEqual(before.texts);

      picked.select(null);
      expect(termDragSelecting()).toBeFalse();
      expect(displayedTermModel(paneModel()).texts).toEqual(["hello", "more output"]);
    } finally {
      stop();
    }
  });

  test("a selection in the buffer puts the row actions away; one elsewhere leaves them", () => {
    const { term, row } = buffer();
    const outside = document.createElement("p");
    outside.textContent = "a diff line";
    appRoot().append(outside);
    const picked = selection(document);
    restoreSelection = picked.restore;
    const stop = bindDragSelection(term);
    try {
      // The first click of a double-click opened them; the second selected a word.
      setPaneRow(0);
      picked.select(outside.firstChild);
      expect(paneRow()).toBe(0);
      picked.select(row.firstChild);
      expect(paneRow()).toBeNull();
      expect(termDragSelecting()).toBeTrue();
    } finally {
      stop();
      setPaneRow(null);
    }
  });

  test("a selection somewhere else on the page is not the buffer's", () => {
    const { term } = buffer();
    const outside = document.createElement("p");
    outside.textContent = "a diff line";
    appRoot().append(outside);
    const picked = selection(document);
    restoreSelection = picked.restore;
    const stop = bindDragSelection(term);
    try {
      picked.select(outside.firstChild);
      expect(termHasSelection()).toBeFalse();
      expect(termDragSelecting()).toBeFalse();
    } finally {
      stop();
    }
  });

  test("focusing a field lets go of the buffer's selection", () => {
    const { term, row } = buffer();
    const field = document.createElement("textarea");
    appRoot().append(field);
    const picked = selection(document);
    restoreSelection = picked.restore;
    const stop = bindDragSelection(term);
    try {
      picked.select(row.firstChild);
      field.dispatchEvent(new happy.Event("focusin", { bubbles: true }) as unknown as Event);
      expect(picked.cleared()).toBe(1);
    } finally {
      stop();
    }
  });

  test("copied text is one line per row, whatever colour runs the row was painted in", () => {
    const term = document.createElement("div");
    term.className = "term";
    const rowOf = (index: number, ...cells: string[]) => {
      const row = document.createElement("div");
      row.className = "term-line";
      row.dataset.row = String(index);
      for (const cell of cells) {
        const span = document.createElement("span");
        span.textContent = cell;
        row.append(span);
      }
      term.append(row);
      return row;
    };
    const first = rowOf(0, "✓", " Loaded 8 files in 42 ms");
    rowOf(1, "\u00a0");
    const last = rowOf(2, "  src/app.ts", "       +12 -4   ");
    appRoot().replaceChildren(term);

    const whole = document.createRange();
    whole.setStart(first, 0);
    whole.setEnd(last, last.childNodes.length);
    expect(selectedTermText(term, whole)).toBe("✓ Loaded 8 files in 42 ms\n\n  src/app.ts       +12 -4");

    // A selection that starts and ends inside cells keeps only what it covers.
    const partial = document.createRange();
    partial.setStart(first.lastChild!.firstChild!, 1);
    partial.setEnd(last.firstChild!.firstChild!, 5);
    expect(selectedTermText(term, partial)).toBe("Loaded 8 files in 42 ms\n\n  src");
  });

  test("unbinding releases a selection it was holding", () => {
    const { term, row } = buffer();
    const picked = selection(document);
    restoreSelection = picked.restore;
    const stop = bindDragSelection(term);
    picked.select(row.firstChild);
    expect(termDragSelecting()).toBeTrue();
    stop();
    expect(termDragSelecting()).toBeFalse();
  });
});

describe("keys while the session holds the keyboard", () => {
  const key = (name: string, init: KeyboardEventInit = {}) =>
    new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;

  test("Ctrl+C copies a selection dragged out of the buffer instead of interrupting", async () => {
    // Where Control+C is the copy shortcut; a Mac is the next test.
    const original = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    restorePlatform = () => Object.defineProperty(navigator, "platform", { value: original, configurable: true });
    const { row } = buffer();
    const picked = selection(document);
    restoreSelection = picked.restore;
    picked.select(row.firstChild);

    const copy = key("c", { ctrlKey: true });
    handlePaneKey(copy, false);
    await flushKeys();
    expect(copy.defaultPrevented).toBeFalse();
    expect(sentKeys).toEqual([]);

    picked.select(null);
    const interrupt = key("c", { ctrlKey: true });
    handlePaneKey(interrupt, false);
    await flushKeys();
    expect(interrupt.defaultPrevented).toBeTrue();
    expect(sentKeys).toEqual([["ctrl+c"]]);
  });

  test("on a Mac Control+C interrupts even over a selection: copying there is Command+C", async () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    restorePlatform = () => Object.defineProperty(navigator, "platform", { value: original, configurable: true });
    const { row } = buffer();
    const picked = selection(document);
    restoreSelection = picked.restore;
    picked.select(row.firstChild);

    const interrupt = key("c", { ctrlKey: true });
    handlePaneKey(interrupt, false);
    await flushKeys();
    expect(interrupt.defaultPrevented).toBeTrue();
    expect(sentKeys).toEqual([["ctrl+c"]]);
    // Command+C is left to the browser, which copies the selection.
    const copy = key("c", { metaKey: true });
    handlePaneKey(copy, false);
    await flushKeys();
    expect(copy.defaultPrevented).toBeFalse();
    expect(sentKeys).toEqual([["ctrl+c"]]);
  });

  test("PageUp and PageDown page the session; with a modifier they stay the browser's", async () => {
    buffer();
    const up = key("PageUp");
    const down = key("PageDown");
    handlePaneKey(up, false);
    handlePaneKey(down, true);
    await wait(0);
    expect(up.defaultPrevented).toBeTrue();
    expect(down.defaultPrevented).toBeTrue();
    expect(sentText).toEqual(["\u001b[5~", "\u001b[6~"]);

    const extend = key("PageDown", { shiftKey: true });
    handlePaneKey(extend, true);
    await wait(0);
    expect(extend.defaultPrevented).toBeFalse();
    expect(sentText).toHaveLength(2);
  });

  test("a phone forwards neither PageUp nor PageDown, from the page or from the field", async () => {
    // What a phone or a tablet's glass reports: no hardware keyboard was ever proven.
    restorePointer = emulateTouchDevice();
    happy.happyDOM.setWindowSize(PHONE);
    buffer();
    const pressed = [key("PageUp"), key("PageDown")];
    handlePaneKey(pressed[0]!, false);
    handlePaneKey(pressed[1]!, true);
    await wait(0);
    expect(pressed.map((event) => event.defaultPrevented)).toEqual([false, false]);
    expect(sentText).toEqual([]);
    expect(sentKeys).toEqual([]);

    // A tablet beside the list is the same until a key proves its keyboard.
    happy.happyDOM.setWindowSize(DESK);
    const unproven = key("PageUp");
    handlePaneKey(unproven, false);
    await wait(0);
    expect(unproven.defaultPrevented).toBeFalse();
    expect(sentText).toEqual([]);
  });

  test("a touch device's wide layout keeps the hold, even for a mouse plugged into it", async () => {
    restorePointer = emulateTouchDevice();
    const { term, row } = buffer();
    const held: number[] = [];
    const stop = bindTap(term, () => undefined, { onHold: (index) => held.push(index) });
    try {
      row.dispatchEvent(pointer("pointerdown", "mouse"));
      await wait(480);
      expect(held).toEqual([0]);
    } finally {
      stop();
    }
  });
});
