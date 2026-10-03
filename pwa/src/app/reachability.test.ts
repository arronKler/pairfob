import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createReachability } from "./reachability";

const timers: Array<{ fn: () => void; ms: number }> = [];
let timeout: ReturnType<typeof spyOn>;
let clear: ReturnType<typeof spyOn>;

beforeEach(() => {
  timers.length = 0;
  timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length;
  }) as typeof setTimeout);
  clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
    const timer = timers[id - 1];
    if (timer) timer.fn = () => {};
  }) as typeof clearTimeout);
});

afterEach(() => { timeout.mockRestore(); clear.mockRestore(); });

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((res) => { resolve = res; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function harness(browserOnline: boolean) {
  const probes: Array<ReturnType<typeof deferred>> = [];
  const applied: boolean[] = [];
  const state = { browserOnline, visible: true, stale: 0 };
  const reachability = createReachability({
    probe: () => { const read = deferred(); probes.push(read); return read.promise; },
    apply: (available) => { applied.push(available); },
    browserOnline: () => state.browserOnline,
    visible: () => state.visible,
    onStaleOfflineHint: () => { state.stale += 1; },
  });
  return { reachability, probes, applied, state };
}

test("an online hint is adopted without a probe", () => {
  const { reachability, probes, applied } = harness(true);
  reachability.report();
  expect(probes).toHaveLength(0);
  expect(applied).toEqual([true]);
});

test("an offline hint is confirmed by the origin before it gates anything", async () => {
  const { reachability, probes, applied, state } = harness(false);
  reachability.report();
  expect(applied).toEqual([]);
  probes[0].resolve(true);
  await flush();
  // The browser said offline but the origin answered: stay online.
  expect(applied).toEqual([true]);
  expect(state.stale).toBe(1);
  expect(timers).toHaveLength(0);
});

test("a confirmed offline keeps re-checking with backoff without an online event", async () => {
  const { reachability, probes, applied } = harness(false);
  reachability.report();
  probes[0].resolve(false);
  await flush();
  expect(applied).toEqual([false]);
  expect(timers.map((timer) => timer.ms)).toEqual([1500]);

  timers[0].fn();
  probes[1].resolve(false);
  await flush();
  expect(timers.map((timer) => timer.ms)).toEqual([1500, 3000]);

  timers[1].fn();
  probes[2].resolve(true);
  await flush();
  expect(applied).toEqual([false, false, true]);
});

test("a newer signal owns the verdict over an in-flight probe", async () => {
  const { reachability, probes, applied, state } = harness(false);
  reachability.report();
  state.browserOnline = true;
  reachability.report();
  expect(applied).toEqual([true]);
  probes[0].resolve(false);
  await flush();
  // The stale offline result neither applies nor schedules a re-check.
  expect(applied).toEqual([true]);
  expect(timers).toHaveLength(0);
});

test("a hidden page stops re-checking and released owners stay silent", async () => {
  const { reachability, probes, applied, state } = harness(false);
  reachability.report();
  probes[0].resolve(false);
  await flush();
  reachability.pause();
  state.visible = false;
  timers[0].fn();
  expect(probes).toHaveLength(1);

  state.visible = true;
  reachability.report();
  reachability.release();
  probes[1].resolve(true);
  await flush();
  expect(applied).toEqual([false]);
  reachability.report();
  expect(probes).toHaveLength(2);
});
