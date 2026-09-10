import { afterEach, beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { morphingPane, nextTransition, resetTransitionState, withTransition } from "./transition";

const original = { set: window.setTimeout, clear: window.clearTimeout };
let timers = new Map<number, () => void>();
let serial = 0;
let oldTransition: PropertyDescriptor | undefined;

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  resetTransitionState();
  timers = new Map();
  serial = 0;
  window.setTimeout = ((callback: () => void) => {
    const id = ++serial;
    timers.set(id, callback);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
  oldTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition");
  Object.defineProperty(document, "startViewTransition", { value: undefined, configurable: true });
});

afterEach(() => {
  resetTransitionState();
  window.setTimeout = original.set;
  window.clearTimeout = original.clear;
  if (oldTransition) Object.defineProperty(document, "startViewTransition", oldTransition);
  else delete (document as Document & { startViewTransition?: unknown }).startViewTransition;
});

test("transition reset cancels every older fallback timer and cannot retire new pane metadata", () => {
  nextTransition("push", "old-1");
  withTransition("push", () => {});
  nextTransition("push", "old-2");
  withTransition("push", () => {});
  resetTransitionState();
  const staleCallbacks = [...timers.values()];
  nextTransition("push", "new");
  withTransition("push", () => {});
  for (const callback of staleCallbacks) callback();
  expect(morphingPane()).toBe("new");
  expect(document.documentElement.dataset.fallbackTransition).toBe("push");
  expect(staleCallbacks.length).toBe(0);
});

test("native transition completion from a retired generation cannot clear a new transition", async () => {
  let finishA!: () => void;
  let finishB!: () => void;
  const a = new Promise<void>((resolve) => { finishA = resolve; });
  const b = new Promise<void>((resolve) => { finishB = resolve; });
  let calls = 0;
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (paint: () => void) => {
      paint();
      return { finished: ++calls === 1 ? a : b };
    },
  });
  nextTransition("push", "old");
  withTransition("push", () => {});
  resetTransitionState();
  nextTransition("pop", "new");
  withTransition("pop", () => {});
  finishA();
  await Promise.resolve();
  await Promise.resolve();
  expect(morphingPane()).toBe("new");
  expect(document.documentElement.dataset.transition).toBe("pop");
  finishB();
  await Promise.resolve();
  await Promise.resolve();
});
