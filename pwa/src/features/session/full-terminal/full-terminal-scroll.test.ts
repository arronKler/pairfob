import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { setLang } from "../../../lib/i18n";
import { appRoot } from "../../../app/dom-root";
import { SCROLL_LINE_PX, bindHostScroll, bindScrollHold, pageLineCount, reportsWheel, type RemoteScroll } from "./full-terminal-scroll";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { SessionScrollRail } from "../guided/session-scroll";

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  setLang("zh");
});

afterEach(() => {
  unmountReact();
  appRoot().replaceChildren();
});

function paintRail(scroll: RemoteScroll, pageLines: () => number): HTMLElement {
  renderReact(createElement(SessionScrollRail, { scroll, pageLines }));
  return appRoot().querySelector<HTMLElement>(".full-terminal-scroll")!;
}

type Call = { direction: "up" | "down"; lines: number; source: "wheel" | "page_key"; at?: { column: number; row: number } };

function pointer(type: string, x: number, y: number, pointerType = "mouse"): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
}

function touchPoint(identifier: number, x: number, y: number, target: EventTarget): Touch {
  return {
    identifier,
    target,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pageX: x,
    pageY: y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  } as Touch;
}

function touchEvent(type: string, touches: Touch[], changedTouches = touches): TouchEvent {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    targetTouches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  return event;
}

const source = await Bun.file(new URL("./full-terminal-scroll.ts", import.meta.url)).text();

describe("complete-terminal remote scroll", () => {
  test("a zoomed page can pan and pinch without remote scroll or terminal clicks", () => {
    const originalViewport = Object.getOwnPropertyDescriptor(happy, "visualViewport");
    const viewport = { scale: 2 };
    Object.defineProperty(happy, "visualViewport", { configurable: true, value: viewport });
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    document.body.append(host);
    const calls: string[] = [];
    xterm.addEventListener("mousedown", () => calls.push("click"));
    const stop = bindHostScroll(host, () => calls.push("scroll"), () => undefined);
    try {
      for (const event of [
        pointer("pointerdown", 80, 240, "touch"),
        touchEvent("touchstart", [touchPoint(7, 80, 240, host)]),
        pointer("pointermove", 80, 140, "touch"),
        touchEvent("touchmove", [touchPoint(7, 80, 140, host)]),
      ]) {
        host.dispatchEvent(event);
        expect(event.defaultPrevented).toBeFalse();
      }
      viewport.scale = 1;
      host.dispatchEvent(pointer("pointerup", 80, 140, "touch"));
      host.dispatchEvent(touchEvent("touchend", [], [touchPoint(7, 80, 140, host)]));
      expect(calls).toEqual([]);
      host.dispatchEvent(touchEvent("touchstart", [touchPoint(8, 80, 240, host)]));
      host.dispatchEvent(touchEvent("touchmove", [touchPoint(8, 80, 140, host)]));
      expect(calls).toEqual(["scroll"]);
    } finally {
      viewport.scale = 1;
      if (originalViewport) Object.defineProperty(happy, "visualViewport", originalViewport);
      else Reflect.deleteProperty(happy, "visualViewport");
      stop();
      host.remove();
    }
  });

  test("a page is the visible viewport minus one overlap row", () => {
    expect(pageLineCount(24)).toBe(23);
    expect(pageLineCount(1)).toBe(1);
    expect(pageLineCount(Number.NaN)).toBe(1);
  });

  test("a second finger drops the pan so pinch can change the type scale", () => {
    expect(source).toContain("event.touches.length !== 1");
    expect(source).toContain('addEventListener("touchstart"');
  });

  test("native touch events pan overflow without relying on pointer delivery", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: 300 });
    host.append(pan);
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { panXScroller: () => pan });
    const start = touchPoint(7, 140, 120, host);
    const move = touchPoint(7, 40, 124, host);
    const down = touchEvent("touchstart", [start]);
    const drag = touchEvent("touchmove", [move]);
    host.dispatchEvent(down);
    host.dispatchEvent(drag);
    expect(down.defaultPrevented).toBeTrue();
    expect(drag.defaultPrevented).toBeTrue();
    expect(pan.scrollLeft).toBe(100);
    expect(calls).toEqual([]);
    stop();
    host.remove();
  });

  test("native touch takes over a duplicate pointer stream exactly once", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: 300 });
    host.append(pan);
    document.body.append(host);
    const stop = bindHostScroll(host, () => undefined, () => undefined, { panXScroller: () => pan });
    host.dispatchEvent(pointer("pointerdown", 140, 120, "touch"));
    host.dispatchEvent(touchEvent("touchstart", [touchPoint(7, 140, 120, host)]));
    host.dispatchEvent(pointer("pointermove", 40, 124, "touch"));
    expect(pan.scrollLeft).toBe(0);
    host.dispatchEvent(touchEvent("touchmove", [touchPoint(7, 40, 124, host)]));
    expect(pan.scrollLeft).toBe(100);
    stop();
    host.remove();
  });

  test("guided mode leaves native touch scrolling to its CSS scrollport", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const stop = bindHostScroll(host, () => undefined, () => undefined, { grabTouch: false, tapAsClick: false });
    const down = touchEvent("touchstart", [touchPoint(7, 80, 240, host)]);
    const move = touchEvent("touchmove", [touchPoint(7, 80, 180, host)]);
    host.dispatchEvent(down);
    host.dispatchEvent(move);
    expect(down.defaultPrevented).toBeFalse();
    expect(move.defaultPrevented).toBeFalse();
    stop();
    host.remove();
  });

  test("native vertical touch scroll is forwarded once", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source, at) => {
      calls.push({ direction, lines, source, at });
    }, () => ({ column: 4, row: 9 }));
    host.dispatchEvent(touchEvent("touchstart", [touchPoint(7, 80, 240, host)]));
    host.dispatchEvent(touchEvent("touchmove", [touchPoint(7, 80, 240 - SCROLL_LINE_PX * 3, host)]));
    host.dispatchEvent(pointer("pointermove", 80, 240 - SCROLL_LINE_PX * 3, "touch"));
    expect(calls).toEqual([{ direction: "down", lines: 3, source: "wheel", at: { column: 4, row: 9 } }]);
    stop();
    host.remove();
  });

  test("a duplicate touch and pointer tap synthesizes one mouse click", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    document.body.append(host);
    const clicks: string[] = [];
    xterm.addEventListener("mousedown", () => clicks.push("down"));
    xterm.addEventListener("mouseup", () => clicks.push("up"));
    const stop = bindHostScroll(host, () => undefined, () => undefined);
    const point = touchPoint(7, 80, 120, host);
    host.dispatchEvent(pointer("pointerdown", 80, 120, "touch"));
    host.dispatchEvent(touchEvent("touchstart", [point]));
    host.dispatchEvent(touchEvent("touchend", [], [point]));
    host.dispatchEvent(pointer("pointerup", 80, 120, "touch"));
    expect(clicks).toEqual(["down", "up"]);
    stop();
    host.remove();
  });

  test("a quick tap is a whole press that can open a link; a held one clicks without the moves", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    xterm.append(screen);
    host.append(xterm);
    document.body.append(host);
    const seen: string[] = [];
    for (const type of ["mousemove", "mousedown", "mouseup"]) screen.addEventListener(type, () => seen.push(type));
    const stop = bindHostScroll(host, () => undefined, () => undefined);
    const clock = performance.now;
    let now = 1000;
    performance.now = () => now;
    try {
      const point = touchPoint(7, 80, 120, host);
      host.dispatchEvent(touchEvent("touchstart", [point]));
      now += 90;
      host.dispatchEvent(touchEvent("touchend", [], [point]));
      // Two moves: from elsewhere, so the link layer sees a new cell, then onto the spot (full-terminal-input.test).
      expect(seen).toEqual(["mousemove", "mousemove", "mousedown", "mouseup"]);
      seen.length = 0;
      host.dispatchEvent(touchEvent("touchstart", [point]));
      now += 700;
      host.dispatchEvent(touchEvent("touchend", [], [point]));
      // Still a click for a TUI that reads the mouse; nothing for the link layer to open.
      expect(seen).toEqual(["mousedown", "mouseup"]);
    } finally {
      performance.now = clock;
      stop();
      host.remove();
    }
  });

  test("a vertical finger pan is forwarded as TUI wheel lines", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source, at) => {
      calls.push({ direction, lines, source, at });
    }, () => ({ column: 4, row: 9 }));
    host.dispatchEvent(pointer("pointerdown", 80, 240));
    host.dispatchEvent(pointer("pointermove", 80, 240 - SCROLL_LINE_PX * 3));
    expect(calls).toEqual([{ direction: "down", lines: 3, source: "wheel", at: { column: 4, row: 9 } }]);
    stop();
    host.remove();
  });

  test("dragging a finger down scrolls the TUI up", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined);
    host.dispatchEvent(pointer("pointerdown", 80, 80));
    host.dispatchEvent(pointer("pointermove", 80, 80 + SCROLL_LINE_PX * 2));
    expect(calls).toEqual([{ direction: "up", lines: 2, source: "wheel" }]);
    stop();
    host.remove();
  });

  test("an 80-column touch drag explicitly pans the overflow scroller", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: 300 });
    host.append(pan);
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { panXScroller: () => pan });
    const down = pointer("pointerdown", 140, 120, "touch");
    host.dispatchEvent(down);
    const move = pointer("pointermove", 40, 124, "touch");
    host.dispatchEvent(move);
    host.dispatchEvent(pointer("pointermove", 20, 125, "touch"));
    expect(down.defaultPrevented).toBeTrue();
    expect(move.defaultPrevented).toBeTrue();
    expect(pan.scrollLeft).toBe(120);
    expect(calls).toEqual([]);
    stop();
    host.remove();
  });

  test("a lost pointer-capture race does not drop the first pan movement", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: 300 });
    host.setPointerCapture = () => { throw new DOMException("inactive pointer", "NotFoundError"); };
    host.append(pan);
    document.body.append(host);
    const stop = bindHostScroll(host, () => undefined, () => undefined, { panXScroller: () => pan });
    host.dispatchEvent(pointer("pointerdown", 140, 120, "touch"));
    host.dispatchEvent(pointer("pointermove", 40, 124, "touch"));
    expect(pan.scrollLeft).toBe(100);
    stop();
    host.remove();
  });

  test("an 80-column scroller still forwards a vertical finger pan", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: 300 });
    host.append(pan);
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source, at) => {
      calls.push({ direction, lines, source, at });
    }, () => ({ column: 4, row: 9 }), { panXScroller: () => pan });
    host.dispatchEvent(pointer("pointerdown", 80, 240, "touch"));
    host.dispatchEvent(pointer("pointermove", 80, 240 - SCROLL_LINE_PX * 3, "touch"));
    expect(calls).toEqual([{ direction: "down", lines: 3, source: "wheel", at: { column: 4, row: 9 } }]);
    expect(pan.scrollLeft).toBe(0);
    stop();
    host.remove();
  });

  test("a sideways wheel is not stolen when the canvas can pan", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    host.append(pan);
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { panXScroller: () => pan });
    host.dispatchEvent(new WheelEvent("wheel", { deltaX: 80, deltaY: 4, bubbles: true, cancelable: true }));
    expect(calls).toEqual([]);
    stop();
    host.remove();
  });

  /**
   * A host with xterm's own wheel listener below it; `wide` holds 300px of
   * terminal in a 100px pan row. `reporting` is an app that asked for the mouse.
   */
  function xtermHost({ wide = true, reporting = false } = {}) {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    const xterm = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: wide ? 300 : 100 });
    pan.append(xterm);
    host.append(pan);
    document.body.append(host);
    const seen: WheelEvent[] = [];
    // xterm answers every wheel it receives, with a mouse report or an arrow key, and stops it.
    xterm.addEventListener("wheel", (event) => {
      seen.push(event as WheelEvent);
      event.preventDefault();
      event.stopPropagation();
    });
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { panXScroller: () => wide ? pan : null, wheelReported: () => reporting });
    const wheel = (init: WheelEventInit): WheelEvent => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      // The test DOM's wheel event does not carry the modifier keys it was made with.
      Object.defineProperties(event, {
        shiftKey: { value: init.shiftKey === true },
        ctrlKey: { value: init.ctrlKey === true },
        metaKey: { value: init.metaKey === true },
      });
      xterm.dispatchEvent(event);
      return event;
    };
    return { pan, seen, calls, wheel, done() { stop(); host.remove(); } };
  }

  test("a trackpad's sideways swipe pans the columns the host cannot show", () => {
    const view = xtermHost();
    const event = view.wheel({ deltaX: 80, deltaY: 4 });
    expect(view.pan.scrollLeft).toBe(80);
    expect(event.defaultPrevented).toBeTrue();
    // Taken before xterm, which would have stopped it.
    expect(view.seen).toEqual([]);
    expect(view.calls).toEqual([]);
    view.done();
  });

  test("Shift turns a mouse wheel on its side", () => {
    const view = xtermHost();
    view.wheel({ deltaY: 120, shiftKey: true });
    expect(view.pan.scrollLeft).toBe(120);
    view.wheel({ deltaY: -40, shiftKey: true });
    expect(view.pan.scrollLeft).toBe(80);
    // A wheel that counts in lines moves a readable distance per line.
    view.wheel({ deltaY: 1, deltaMode: 1, shiftKey: true });
    expect(view.pan.scrollLeft).toBe(112);
    expect(view.seen).toEqual([]);
    view.done();
  });

  test("a vertical wheel over a panned terminal scrolls the pane and pans nothing", () => {
    const view = xtermHost();
    const event = view.wheel({ deltaY: SCROLL_LINE_PX, deltaX: 2 });
    expect(view.pan.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBeTrue();
    expect(view.seen).toEqual([]);
    expect(view.calls).toEqual([{ direction: "down", lines: 1, source: "wheel" }]);
    view.done();
  });

  test("a pinch-zoom or browser-zoom wheel is never a pan", () => {
    const view = xtermHost();
    const event = view.wheel({ deltaX: 80, ctrlKey: true });
    expect(view.pan.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBeFalse();
    view.done();
  });

  test("a wheel over xterm scrolls the pane on the computer instead of typing arrow keys", () => {
    const view = xtermHost({ wide: false });
    const down = view.wheel({ deltaY: SCROLL_LINE_PX * 2 });
    const up = view.wheel({ deltaY: -SCROLL_LINE_PX });
    // xterm keeps no scrollback, so any wheel it saw here would be an arrow key in the shell.
    expect(view.seen).toEqual([]);
    expect(down.defaultPrevented).toBeTrue();
    expect(up.defaultPrevented).toBeTrue();
    expect(view.calls).toEqual([
      { direction: "down", lines: 2, source: "wheel" },
      { direction: "up", lines: 1, source: "wheel" },
    ]);
    view.done();
  });

  test("a wheel too short for a line is still kept from xterm", () => {
    const view = xtermHost({ wide: false });
    view.wheel({ deltaY: SCROLL_LINE_PX / 2 });
    expect(view.calls).toEqual([]);
    view.wheel({ deltaY: SCROLL_LINE_PX / 2 });
    expect(view.calls).toEqual([{ direction: "down", lines: 1, source: "wheel" }]);
    expect(view.seen).toEqual([]);
    view.done();
  });

  test("an app that asked for mouse reports keeps the wheel", () => {
    const view = xtermHost({ wide: false, reporting: true });
    const event = view.wheel({ deltaY: SCROLL_LINE_PX * 2 });
    expect(view.seen).toEqual([event]);
    expect(view.calls).toEqual([]);
    view.done();
  });

  test("a sideways pan comes before an app's mouse reports", () => {
    const view = xtermHost({ reporting: true });
    view.wheel({ deltaX: 80, deltaY: 4 });
    expect(view.pan.scrollLeft).toBe(80);
    expect(view.seen).toEqual([]);
    view.done();
  });

  test("a pinch or browser zoom over xterm is the browser's, not arrow keys", () => {
    const view = xtermHost({ wide: false });
    for (const event of [view.wheel({ deltaY: -120, ctrlKey: true }), view.wheel({ deltaY: 120, metaKey: true })]) {
      expect(event.defaultPrevented).toBeFalse();
    }
    expect(view.seen).toEqual([]);
    expect(view.calls).toEqual([]);
    view.done();
  });

  test("only the mouse protocols that carry the wheel count as reporting it", () => {
    expect(["vt200", "drag", "any"].map(reportsWheel)).toEqual([true, true, true]);
    // X10 reports presses only, so its wheel would still be typed as arrows.
    expect(["none", "x10", undefined].map(reportsWheel)).toEqual([false, false, false]);
  });

  test("mouse selection does not become a drag-to-pan gesture", () => {
    const host = document.createElement("div");
    const pan = document.createElement("div");
    Object.defineProperty(pan, "clientWidth", { value: 100 });
    Object.defineProperty(pan, "scrollWidth", { value: 300 });
    host.append(pan);
    document.body.append(host);
    const stop = bindHostScroll(host, () => undefined, () => undefined, { panXScroller: () => pan });
    host.dispatchEvent(pointer("pointerdown", 140, 120, "mouse"));
    host.dispatchEvent(pointer("pointermove", 40, 124, "mouse"));
    expect(pan.scrollLeft).toBe(0);
    stop();
    host.remove();
  });

  test("a horizontal pan is not treated as scroll", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined);
    host.dispatchEvent(pointer("pointerdown", 40, 120));
    host.dispatchEvent(pointer("pointermove", 120, 124));
    expect(calls).toEqual([]);
    stop();
    host.remove();
  });

  test("a mouse wheel still maps onto the same remote scroll", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined);
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: SCROLL_LINE_PX, bubbles: true, cancelable: true }));
    expect(calls).toEqual([{ direction: "down", lines: 1, source: "wheel" }]);
    stop();
    host.remove();
  });

  test("a still touch tap is forwarded as a mouse click on xterm", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    document.body.append(host);
    const clicks: string[] = [];
    const scrolls: Call[] = [];
    xterm.addEventListener("mousedown", () => clicks.push("down"));
    xterm.addEventListener("mouseup", () => clicks.push("up"));
    const stop = bindHostScroll(host, (direction, lines, source) => {
      scrolls.push({ direction, lines, source });
    }, () => undefined);
    host.dispatchEvent(pointer("pointerdown", 80, 120, "touch"));
    host.dispatchEvent(pointer("pointerup", 81, 121, "touch"));
    expect(clicks).toEqual(["down", "up"]);
    expect(scrolls).toEqual([]);
    stop();
    host.remove();
  });

  test("a mouse click is not synthesized twice", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    document.body.append(host);
    const clicks: string[] = [];
    xterm.addEventListener("mousedown", () => clicks.push("down"));
    const stop = bindHostScroll(host, () => undefined, () => undefined);
    host.dispatchEvent(pointer("pointerdown", 80, 120, "mouse"));
    host.dispatchEvent(pointer("pointerup", 80, 120, "mouse"));
    expect(clicks).toEqual([]);
    stop();
    host.remove();
  });

  test("an engaged pan does not also click", () => {
    const host = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    host.append(xterm);
    document.body.append(host);
    const clicks: string[] = [];
    xterm.addEventListener("mousedown", () => clicks.push("down"));
    const stop = bindHostScroll(host, () => undefined, () => undefined);
    host.dispatchEvent(pointer("pointerdown", 80, 240, "touch"));
    host.dispatchEvent(pointer("pointermove", 80, 240 - SCROLL_LINE_PX * 3, "touch"));
    host.dispatchEvent(pointer("pointerup", 80, 240 - SCROLL_LINE_PX * 3, "touch"));
    expect(clicks).toEqual([]);
    stop();
    host.remove();
  });

  test("capturePan false leaves the gesture to the host scroller", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { capturePan: () => false, grabTouch: false, tapAsClick: false });
    host.dispatchEvent(pointer("pointerdown", 80, 240, "touch"));
    host.dispatchEvent(pointer("pointermove", 80, 240 - SCROLL_LINE_PX * 3, "touch"));
    expect(calls).toEqual([]);
    stop();
    host.remove();
  });

  /*
    A local band that moved the rows under the finger read as a shake next to the
    snapshot that lands a frame later, so a drag paints nothing of its own: the
    pane only moves when the runtime answers.
  */
  test("a drag moves nothing locally; only the remote answer moves the rows", () => {
    const host = document.createElement("div");
    const surface = document.createElement("div");
    host.append(surface);
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, {});

    host.dispatchEvent(pointer("pointerdown", 80, 240));
    host.dispatchEvent(pointer("pointermove", 80, 240 - 20));
    expect(calls).toEqual([]);
    expect(surface.style.transform).toBe("");

    host.scrollTop = 41;
    host.dispatchEvent(pointer("pointerup", 80, 220));
    expect(surface.style.transform).toBe("");
    // The scroller is left where the reader put it, not re-aimed on release.
    expect(host.scrollTop).toBe(41);
    stop();
    host.remove();
  });

  test("the on-screen rail offers wheel and page-key scrolling", () => {
    const calls: Call[] = [];
    let pageLines = 23;
    const rail = paintRail((direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => pageLines);
    const buttons = [...rail.querySelectorAll("button")] as HTMLButtonElement[];
    expect(buttons.map((el) => el.getAttribute("aria-label"))).toEqual([
      "向上滚动",
      "上一页",
      "下一页",
      "向下滚动",
    ]);
    act(() => buttons[1].dispatchEvent(pointer("pointerdown", 10, 10)));
    pageLines = 31;
    act(() => buttons[2].dispatchEvent(pointer("pointerdown", 10, 10)));
    expect(calls).toEqual([
      { direction: "up", lines: 23, source: "page_key" },
      { direction: "down", lines: 31, source: "page_key" },
    ]);
    unmountReact();
  });

  test("keyboard activation fires once without duplicating pointer or Space clicks", () => {
    const calls: Call[] = [];
    const rail = paintRail((direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => 19);
    const [lineUp, pageUp] = [...rail.querySelectorAll("button")] as HTMLButtonElement[];

    act(() => {
      lineUp.dispatchEvent(pointer("pointerdown", 10, 10));
      lineUp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      pageUp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    });
    const spaceDown = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const spaceRepeat = new KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true, cancelable: true });
    const spaceUp = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    act(() => {
      lineUp.dispatchEvent(spaceDown);
      lineUp.dispatchEvent(spaceRepeat);
    });
    expect(calls).toHaveLength(2);
    act(() => lineUp.dispatchEvent(spaceUp));

    expect(calls).toEqual([
      { direction: "up", lines: 3, source: "wheel" },
      { direction: "up", lines: 19, source: "page_key" },
      { direction: "up", lines: 3, source: "wheel" },
    ]);
    expect(spaceDown.defaultPrevented).toBeTrue();
    expect(spaceRepeat.defaultPrevented).toBeTrue();
    expect(spaceUp.defaultPrevented).toBeTrue();
    unmountReact();
  });

  test("all four rail buttons consume touch and compatibility clicks without reaching the terminal", () => {
    const calls: Call[] = [];
    const rail = paintRail((direction, lines, source) => calls.push({ direction, lines, source }), () => 19);
    const host = rail.parentElement!;
    const escaped: string[] = [];
    const record = (event: Event) => escaped.push(event.type);
    const types = ["pointerdown", "touchstart", "pointerup", "touchend", "mousedown", "mouseup", "click"];
    types.forEach((type) => host.addEventListener(type, record));
    const stopHost = bindHostScroll(host, () => escaped.push("host scroll"), () => undefined);
    try {
      for (const button of rail.querySelectorAll("button")) {
        // The icon, not the button itself, is the usual hit target on a phone.
        const target = button.querySelector("svg")!;
        const touch = touchPoint(1, 10, 10, target);
        const events = [
          pointer("pointerdown", 10, 10, "touch"),
          touchEvent("touchstart", [touch]),
          pointer("pointerup", 10, 10, "touch"),
          touchEvent("touchend", [], [touch]),
          ...["mousedown", "mouseup", "click"].map((type) =>
            new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 })),
        ];
        act(() => events.forEach((event) => target.dispatchEvent(event)));
        expect(events.every((event) => event.defaultPrevented)).toBeTrue();
      }
      expect(escaped).toEqual([]);
      expect(calls).toEqual([
        { direction: "up", lines: 3, source: "wheel" },
        { direction: "up", lines: 19, source: "page_key" },
        { direction: "down", lines: 19, source: "page_key" },
        { direction: "down", lines: 3, source: "wheel" },
      ]);
    } finally {
      stopHost();
      types.forEach((type) => host.removeEventListener(type, record));
    }
  });

  test("bindScrollHold cancels repeat timers on dispose even while connected", async () => {
    const el = document.createElement("button");
    document.body.append(el);
    const calls: number[] = [];
    const stop = bindScrollHold(el, () => calls.push(1));
    el.dispatchEvent(pointer("pointerdown", 10, 10));
    expect(calls).toEqual([1]);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(calls).toEqual([1]);
    el.dispatchEvent(pointer("pointerdown", 10, 10));
    expect(calls).toEqual([1]);
    el.remove();
  });
});
