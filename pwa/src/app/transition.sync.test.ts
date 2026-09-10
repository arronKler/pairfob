import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "navigator"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.matchMedia = happy.matchMedia.bind(happy);

const { morphingPane, nextTransition, resetTransitionState, takeTransition, withSynchronousTransition,
  withTransition } = await import("./transition.ts");

/**
 * Synchronous transition adapter entry (`withSynchronousTransition`).
 *
 * The public synchronous commit/navigation boundary uses this entry instead of
 * `withTransition`: it animates the arriving screen through the SAME arrival-only
 * CSS fallback engine (`html[data-fallback-transition]` + the animation-window
 * timer), never starts a native ViewTransition, and stays reduced-motion aware.
 * `withTransition` itself keeps its native update-callback behavior for the
 * explicitly asynchronous/legacy renderer path.
 */

let timers = new Map<number, () => void>();
let serial = 0;
const realSet = window.setTimeout.bind(window);
const realClear = window.clearTimeout.bind(window);

beforeEach(() => {
  takeTransition();
  resetTransitionState();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  timers = new Map();
  serial = 0;
  window.setTimeout = ((callback: () => void) => {
    const id = ++serial;
    timers.set(id, callback);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
});

afterEach(() => {
  resetTransitionState();
  window.setTimeout = realSet;
  window.clearTimeout = realClear;
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("synchronous transition entry", () => {
  test("never starts a native ViewTransition even when one is available, and shares the fallback marker", () => {
    let native = 0;
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: ((fn: () => void) => { native += 1; fn(); return { finished: Promise.resolve() }; }),
    });
    let painted = 0;
    nextTransition("push");
    withSynchronousTransition(takeTransition(), () => { painted += 1; });
    expect(native).toBe(0);
    expect(painted).toBe(1);
    expect(document.documentElement.dataset.fallbackTransition).toBe("push");
    expect(timers.size).toBe(1);
  });

  test("marks before painting and self-clears the marker after the animation window", () => {
    const marks: Array<string | undefined> = [];
    let painted = 0;
    withSynchronousTransition("fade", () => {
      marks.push(document.documentElement.dataset.fallbackTransition);
      painted += 1;
    });
    // The arrival marker is on before the DOM update runs, so the CSS animates
    // the arriving screen.
    expect(marks).toEqual(["fade"]);
    expect(painted).toBe(1);
    expect(timers.size).toBe(1);
    for (const callback of [...timers.values()]) callback();
    expect(document.documentElement.dataset.fallbackTransition).toBeUndefined();
  });

  test("the paint still happens and nothing is scheduled after resetTransitionState", () => {
    let painted = 0;
    withSynchronousTransition("pop", () => { painted += 1; });
    resetTransitionState();
    expect(painted).toBe(1);
    expect(document.documentElement.dataset.fallbackTransition).toBeUndefined();
    expect(timers.size).toBe(0);
  });

  test("reduced motion paints immediately with no marker and no cleanup timer", () => {
    const realMatch = g.matchMedia;
    g.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
    try {
      let painted = 0;
      withSynchronousTransition("push", () => { painted += 1; });
      expect(painted).toBe(1);
      expect(document.documentElement.dataset.fallbackTransition).toBeUndefined();
      expect(timers.size).toBe(0);
    } finally {
      g.matchMedia = realMatch;
      resetTransitionState();
    }
  });

  test("the fallback pane id is retired by the animation-window cleanup like the ordinary adapter", () => {
    nextTransition("push", "pane_7");
    withSynchronousTransition(takeTransition(), () => {});
    expect(morphingPane()).toBe("pane_7");
    for (const callback of [...timers.values()]) callback();
    expect(morphingPane()).toBeNull();
  });

  test("the ordinary adapter keeps its native update-callback path unchanged", () => {
    let update: (() => void) | undefined;
    let native = 0;
    const original = Object.getOwnPropertyDescriptor(document, "startViewTransition");
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: ((fn: () => void) => { native += 1; update = fn; return { finished: Promise.resolve() }; }),
    });
    try {
      let painted = 0;
      withTransition("push", () => { painted += 1; });
      // Native path: the update callback is deferred, not run by the adapter.
      expect(native).toBe(1);
      expect(painted).toBe(0);
      expect(document.documentElement.dataset.transition).toBe("push");
      update?.();
      expect(painted).toBe(1);
    } finally {
      if (original) Object.defineProperty(document, "startViewTransition", original);
      else delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
      resetTransitionState();
    }
  });
});