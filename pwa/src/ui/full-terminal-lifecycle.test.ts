import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const happy = new Window({ url: "https://pairfob.test" });
const g = globalThis as typeof globalThis & { window: Window; document: Document; ResizeObserver: typeof ResizeObserver };
g.window = happy;
g.document = happy.document;

const nativeFrame = happy.requestAnimationFrame.bind(happy);
const nativeCancelFrame = happy.cancelAnimationFrame.bind(happy);
const nativeTimeout = happy.setTimeout.bind(happy);
const nativeClearTimeout = happy.clearTimeout.bind(happy);
const nativeResizeObserver = globalThis.ResizeObserver;

const { afterNextPaint, observeHostResize } = await import("./full-terminal-lifecycle.ts");

afterEach(() => {
  happy.requestAnimationFrame = nativeFrame;
  happy.cancelAnimationFrame = nativeCancelFrame;
  happy.setTimeout = nativeTimeout;
  happy.clearTimeout = nativeClearTimeout;
  g.ResizeObserver = nativeResizeObserver;
});

describe("full-terminal mount lifecycle", () => {
  test("runs expensive mounting only after a frame and a following task", () => {
    let frame: FrameRequestCallback | undefined;
    let task: TimerHandler | undefined;
    let ran = false;
    happy.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frame = callback;
      return 11;
    }) as typeof happy.requestAnimationFrame;
    happy.setTimeout = ((callback: TimerHandler) => {
      task = callback;
      return 12;
    }) as typeof happy.setTimeout;

    afterNextPaint(() => { ran = true; });
    expect(ran).toBeFalse();
    frame?.(0);
    expect(ran).toBeFalse();
    if (typeof task === "function") task();
    expect(ran).toBeTrue();
  });

  test("cancels a mount queued after the shell paint", () => {
    let frame: FrameRequestCallback | undefined;
    let ran = false;
    happy.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frame = callback;
      return 21;
    }) as typeof happy.requestAnimationFrame;
    const cancel = afterNextPaint(() => { ran = true; });
    cancel();
    frame?.(0);
    expect(ran).toBeFalse();
  });

  test("does not repeat the initial fit until the host size changes", () => {
    let notify: ResizeObserverCallback | undefined;
    class Observer {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): ResizeObserverEntry[] { return []; }
    }
    g.ResizeObserver = Observer as unknown as typeof ResizeObserver;
    const host = happy.document.createElement("div");
    let width = 390;
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => 700 });
    let fits = 0;
    observeHostResize(host, () => { fits++; });
    notify?.([], {} as ResizeObserver);
    expect(fits).toBe(0);
    width = 844;
    notify?.([], {} as ResizeObserver);
    expect(fits).toBe(1);
  });
});
