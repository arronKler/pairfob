import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM, happy } from "../../test-support/dom";
import { bindVisualViewport, releaseVisualViewport, scheduleVisualViewport } from "./viewport";

const original = {
  set: window.setTimeout, clear: window.clearTimeout,
  raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame,
};
let timers = new Map<number, () => void>();
let frames = new Map<number, FrameRequestCallback>();
let serial = 0;

beforeEach(async () => {
  await resetBoardTestDOM();
  releaseVisualViewport();
  timers = new Map();
  frames = new Map();
  serial = 0;
  window.setTimeout = ((callback: () => void) => {
    const id = ++serial;
    timers.set(id, callback);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++serial;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
});

afterEach(() => {
  releaseVisualViewport();
  window.setTimeout = original.set;
  window.clearTimeout = original.clear;
  globalThis.requestAnimationFrame = original.raf;
  globalThis.cancelAnimationFrame = original.cancel;
});

function fireFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const fn of queued) fn(performance.now());
}

test("viewport release retires already queued focus RAF before a replacement binding", () => {
  let oldCalls = 0;
  let newCalls = 0;
  const oldStop = bindVisualViewport(() => { oldCalls += 1; });
  scheduleVisualViewport(() => { oldCalls += 1; });
  expect(oldCalls).toBe(1);
  oldStop();
  bindVisualViewport(() => { newCalls += 1; });
  fireFrames();
  expect(oldCalls).toBe(1);
  expect(newCalls).toBe(0);
});

test("stale viewport disposer cannot reset the replacement keyboard listener/timers", () => {
  let newCalls = 0;
  const oldStop = bindVisualViewport(() => {});
  bindVisualViewport(() => { newCalls += 1; });
  scheduleVisualViewport(() => { newCalls += 1; });
  const pending = timers.size;
  oldStop();
  expect(timers.size).toBe(pending);
});

test("retired viewport native listener is removed while replacement receives one resize", () => {
  let a = 0;
  let b = 0;
  const oldStop = bindVisualViewport(() => { a += 1; });
  oldStop();
  bindVisualViewport(() => { b += 1; });
  happy.happyDOM.setWindowSize({ width: 400, height: 900 });
  window.dispatchEvent(new happy.Event("resize"));
  expect(a).toBe(0);
  expect(b).toBe(1);
});
