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

  test("coalesces keyboard-like height changes until the host settles", () => {
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
    let height = 700;
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 390 });
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => height });
    let task: TimerHandler | undefined;
    happy.setTimeout = ((callback: TimerHandler, delay?: number) => {
      expect(delay).toBe(120);
      task = callback;
      return 31;
    }) as typeof happy.setTimeout;
    happy.clearTimeout = ((id?: number) => {
      if (id === 31) task = undefined;
    }) as typeof happy.clearTimeout;
    let fits = 0;
    observeHostResize(host, () => { fits++; });

    height = 620;
    notify?.([], {} as ResizeObserver);
    height = 480;
    notify?.([], {} as ResizeObserver);
    expect(fits).toBe(0);
    if (typeof task === "function") task();
    expect(fits).toBe(1);
  });

  test("keeps width changes immediate and cancels a pending fit on disconnect", () => {
    let notify: ResizeObserverCallback | undefined;
    let disconnected = false;
    class Observer {
      constructor(callback: ResizeObserverCallback) { notify = callback; }
      observe() {}
      unobserve() {}
      disconnect() { disconnected = true; }
      takeRecords(): ResizeObserverEntry[] { return []; }
    }
    g.ResizeObserver = Observer as unknown as typeof ResizeObserver;
    const host = happy.document.createElement("div");
    let width = 390;
    let height = 700;
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => height });
    let task: TimerHandler | undefined;
    happy.setTimeout = ((callback: TimerHandler) => {
      task = callback;
      return 41;
    }) as typeof happy.setTimeout;
    happy.clearTimeout = (() => { task = undefined; }) as typeof happy.clearTimeout;
    let fits = 0;
    const observed = observeHostResize(host, () => { fits++; });

    width = 844;
    notify?.([], {} as ResizeObserver);
    expect(fits).toBe(1);
    height = 500;
    notify?.([], {} as ResizeObserver);
    observed?.disconnect();
    if (typeof task === "function") task();
    expect(fits).toBe(1);
    expect(disconnected).toBeTrue();
  });

  test("keeps desktop height changes immediate", () => {
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
    let height = 700;
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 1024 });
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => height });
    let fits = 0;
    observeHostResize(host, () => { fits++; }, { settleHeight: false });

    height = 500;
    notify?.([], {} as ResizeObserver);
    expect(fits).toBe(1);
  });
});
