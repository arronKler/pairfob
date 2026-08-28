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

const source = await Bun.file(new URL("./full-terminal-scroll.ts", import.meta.url)).text();

describe("complete-terminal remote scroll", () => {
  test("a page is the visible viewport minus one overlap row", () => {
    expect(pageLineCount(24)).toBe(23);
    expect(pageLineCount(1)).toBe(1);
    expect(pageLineCount(Number.NaN)).toBe(1);
  });

  test("a second finger drops the pan so pinch can change the type scale", () => {
    expect(source).toContain("event.touches.length > 1");
    expect(source).toContain('addEventListener("touchstart"');
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

  test("nativePanX leaves a sideways drag to the host scroller", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { nativePanX: () => true });
    const down = pointer("pointerdown", 40, 120, "touch");
    host.dispatchEvent(down);
    host.dispatchEvent(pointer("pointermove", 140, 124, "touch"));
    expect(down.defaultPrevented).toBeFalse();
    expect(calls).toEqual([]);
    stop();
    host.remove();
  });

  test("nativePanX still forwards a vertical finger pan", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source, at) => {
      calls.push({ direction, lines, source, at });
    }, () => ({ column: 4, row: 9 }), { nativePanX: () => true });
    host.dispatchEvent(pointer("pointerdown", 80, 240, "touch"));
    host.dispatchEvent(pointer("pointermove", 80, 240 - SCROLL_LINE_PX * 3, "touch"));
    expect(calls).toEqual([{ direction: "down", lines: 3, source: "wheel", at: { column: 4, row: 9 } }]);
    stop();
    host.remove();
  });

  test("a sideways wheel is not stolen when the canvas can pan", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const calls: Call[] = [];
    const stop = bindHostScroll(host, (direction, lines, source) => {
      calls.push({ direction, lines, source });
    }, () => undefined, { nativePanX: () => true });
    host.dispatchEvent(new WheelEvent("wheel", { deltaX: 80, deltaY: 4, bubbles: true, cancelable: true }));
    expect(calls).toEqual([]);
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
