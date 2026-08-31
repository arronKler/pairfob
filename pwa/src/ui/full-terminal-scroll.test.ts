import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;
g.HTMLButtonElement = happy.HTMLButtonElement;
g.Node = happy.Node;
g.PointerEvent = happy.PointerEvent;
g.TouchEvent = happy.TouchEvent;
g.WheelEvent = happy.WheelEvent;
g.MouseEvent = happy.MouseEvent;
g.KeyboardEvent = happy.KeyboardEvent;
happy.document.body.innerHTML = '<main id="app"></main>';

const { SCROLL_LINE_PX, bindHostScroll, pageLineCount, scrollRail } = await import("./full-terminal-scroll.ts");

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

  test("the on-screen rail offers wheel and page-key scrolling", () => {
    const calls: Call[] = [];
    let pageLines = 23;
    const rail = scrollRail((direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => pageLines);
    document.body.append(rail);
    const buttons = [...rail.querySelectorAll("button")] as HTMLButtonElement[];
    expect(buttons.map((el) => el.getAttribute("aria-label"))).toEqual([
      "鼠标滚轮向上",
      "上一页",
      "下一页",
      "鼠标滚轮向下",
    ]);
    buttons[1].dispatchEvent(pointer("pointerdown", 10, 10));
    pageLines = 31;
    buttons[2].dispatchEvent(pointer("pointerdown", 10, 10));
    expect(calls).toEqual([
      { direction: "up", lines: 23, source: "page_key" },
      { direction: "down", lines: 31, source: "page_key" },
    ]);
    rail.remove();
  });

  test("keyboard activation fires once without duplicating pointer or Space clicks", () => {
    const calls: Call[] = [];
    const rail = scrollRail((direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => 19);
    document.body.append(rail);
    const [lineUp, pageUp] = [...rail.querySelectorAll("button")] as HTMLButtonElement[];

    lineUp.dispatchEvent(pointer("pointerdown", 10, 10));
    lineUp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    pageUp.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    const spaceDown = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    const spaceRepeat = new KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true, cancelable: true });
    const spaceUp = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    lineUp.dispatchEvent(spaceDown);
    lineUp.dispatchEvent(spaceRepeat);
    expect(calls).toHaveLength(2);
    lineUp.dispatchEvent(spaceUp);

    expect(calls).toEqual([
      { direction: "up", lines: 3, source: "wheel" },
      { direction: "up", lines: 19, source: "page_key" },
      { direction: "up", lines: 3, source: "wheel" },
    ]);
    expect(spaceDown.defaultPrevented).toBeTrue();
    expect(spaceRepeat.defaultPrevented).toBeTrue();
    expect(spaceUp.defaultPrevented).toBeTrue();
    rail.remove();
  });
});
