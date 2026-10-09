import { expectSameNodes } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindPanBar, syncPanBar } from "./full-terminal-pan-bar";

const nativeResizeObserver = globalThis.ResizeObserver;

beforeEach(async () => {
  await resetBoardTestDOM();
});

afterEach(() => {
  globalThis.ResizeObserver = nativeResizeObserver;
});

/** A pan row showing `shown` of `total` pixels, with the bar's track 600px wide at x=100. */
function panRow(total: number, shown: number) {
  const host = document.createElement("div");
  host.innerHTML = '<div class="full-terminal-pan"><div class="full-terminal-canvas"></div></div>'
    + '<div class="full-terminal-pan-bar"><span class="full-terminal-pan-thumb"></span></div>';
  document.body.append(host);
  const pan = host.querySelector<HTMLElement>(".full-terminal-pan")!;
  const bar = host.querySelector<HTMLElement>(".full-terminal-pan-bar")!;
  const thumb = bar.querySelector<HTMLElement>(".full-terminal-pan-thumb")!;
  let scrollWidth = total;
  Object.defineProperties(pan, {
    scrollWidth: { get: () => scrollWidth },
    clientWidth: { get: () => shown },
  });
  const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 8, height: 8, x: left, y: 0, toJSON() {} }) as DOMRect;
  bar.getBoundingClientRect = () => rect(100, 600);
  thumb.getBoundingClientRect = () => {
    const width = (Number.parseFloat(thumb.style.width) / 100) * 600;
    return rect(100 + (Number.parseFloat(thumb.style.left) / 100) * 600, width);
  };
  const stop = bindPanBar(bar, pan);
  const press = (type: string, x: number): PointerEvent => {
    const event = new happy.PointerEvent(type, {
      pointerId: 1, isPrimary: true, pointerType: "mouse", clientX: x, clientY: 4, button: 0, bubbles: true, cancelable: true,
    }) as unknown as PointerEvent;
    bar.dispatchEvent(event);
    return event;
  };
  return {
    host, pan, bar, thumb, press,
    resize(next: number) { scrollWidth = next; pan.dispatchEvent(new happy.Event("scroll") as unknown as Event); },
    /** xterm redraws its grid `next` pixels wide; the pan row and the canvas keep their boxes, so nothing fires. */
    redraw(next: number) { scrollWidth = next; },
    done() { stop(); host.remove(); },
  };
}

describe("the bar under a terminal wider than its column", () => {
  test("it shows how much of the terminal is in view and where", () => {
    const view = panRow(1200, 600);
    expect(view.bar.hidden).toBeFalse();
    expect(view.thumb.style.width).toBe("50%");
    expect(view.thumb.style.left).toBe("0%");

    view.pan.scrollLeft = 300;
    view.pan.dispatchEvent(new happy.Event("scroll") as unknown as Event);
    expect(view.thumb.style.left).toBe("25%");
    view.done();
  });

  test("a terminal that fits, or overflows by a rounding remainder, has no bar", () => {
    const view = panRow(600, 600);
    expect(view.bar.hidden).toBeTrue();
    view.resize(601);
    expect(view.bar.hidden).toBeTrue();
    view.resize(900);
    expect(view.bar.hidden).toBeFalse();
    view.done();
  });

  test("dragging the thumb pans, and the press never reaches the terminal", () => {
    const view = panRow(1200, 600);
    let reached = 0;
    view.host.addEventListener("pointerdown", () => { reached++; });
    // Grab the 300px thumb 50px in and drag it 150px: half of its travel.
    const down = view.press("pointerdown", 150);
    expect(down.defaultPrevented).toBeTrue();
    expect(reached).toBe(0);
    expect(view.bar.classList.contains("is-dragging")).toBeTrue();
    view.press("pointermove", 300);
    expect(view.pan.scrollLeft).toBe(300);
    view.press("pointermove", 9999);
    expect(view.pan.scrollLeft).toBe(600);
    view.press("pointerup", 9999);
    expect(view.bar.classList.contains("is-dragging")).toBeFalse();
    view.press("pointermove", 100);
    expect(view.pan.scrollLeft).toBe(600);
    view.done();
  });

  test("a press beside the thumb brings its middle under the pointer", () => {
    const view = panRow(1200, 600);
    // The thumb spans 100..400; press at 550 puts its centre there: left edge at 400 of 300 travel.
    view.press("pointerdown", 550);
    expect(view.pan.scrollLeft).toBe(600);
    view.press("pointerup", 550);
    view.done();
  });

  test("unbinding stops following the pan row", () => {
    const view = panRow(1200, 600);
    view.done();
    view.pan.scrollLeft = 300;
    view.pan.dispatchEvent(new happy.Event("scroll") as unknown as Event);
    expect(view.thumb.style.left).toBe("0%");
  });

  test("a fit reads the overflow again: the grid changed width inside boxes that kept theirs", () => {
    // The window narrowed onto the grid of the wider one, and the bar was told of that.
    const view = panRow(1200, 600);
    expect(view.bar.hidden).toBeFalse();
    // The fit that followed drew a grid that fits. No box resized and nothing scrolled.
    view.redraw(600);
    expect(view.bar.hidden).toBeFalse();
    syncPanBar(view.host);
    expect(view.bar.hidden).toBeTrue();

    // And the other way: columns the narrower host cannot show.
    view.redraw(900);
    syncPanBar(view.host);
    expect(view.bar.hidden).toBeFalse();
    expect(view.thumb.style.width).toBe(`${(600 / 900) * 100}%`);

    // An unbound bar is left alone.
    view.done();
    view.redraw(600);
    syncPanBar(view.host);
    expect(view.bar.hidden).toBeFalse();
  });

  test("xterm's own box is watched from the fit that finds it, and let go when the renderer is replaced", () => {
    const watched = new Set<Element>();
    let notify: (() => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { notify = () => callback([], this as unknown as ResizeObserver); }
      observe(node: Element) { watched.add(node); }
      unobserve(node: Element) { watched.delete(node); }
      disconnect() { watched.clear(); }
      takeRecords(): ResizeObserverEntry[] { return []; }
    } as unknown as typeof ResizeObserver;
    const view = panRow(600, 600);
    const canvas = view.pan.querySelector(".full-terminal-canvas")!;
    expectSameNodes(watched, [view.pan, canvas]);

    canvas.innerHTML = '<div class="xterm"><div class="xterm-screen"></div></div>';
    const first = canvas.querySelector(".xterm-screen")!;
    syncPanBar(view.host);
    expect(watched.has(first)).toBeTrue();
    // The renderer resized its grid later than the fit that asked (a page out of view): its box says so.
    view.redraw(900);
    notify?.();
    expect(view.bar.hidden).toBeFalse();

    canvas.innerHTML = '<div class="xterm"><div class="xterm-screen"></div></div>';
    view.redraw(600);
    syncPanBar(view.host);
    expect(watched.has(first)).toBeFalse();
    expect(watched.has(canvas.querySelector(".xterm-screen")!)).toBeTrue();
    expect(view.bar.hidden).toBeTrue();
    view.done();
    expect(watched.size).toBe(0);
  });
});
