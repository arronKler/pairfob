import { describe, expect, test } from "bun:test";

import { LiveInputPump, type LiveInputFailure, type LiveInputPumpState } from "./live-input";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness() {
  const scheduled: Array<() => void> = [];
  const requests: Array<{ text: string; done: Deferred }> = [];
  const events: string[] = [];
  const states: LiveInputPumpState[] = [];
  const failures: Array<{ error: unknown; input: LiveInputFailure }> = [];
  const pump = new LiveInputPump({
    schedule: (run) => {
      scheduled.push(run);
      return run;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
    send: (text) => {
      events.push(`send:${text}`);
      const done = deferred();
      requests.push({ text, done });
      return done.promise;
    },
    requestRead: () => events.push("read"),
    onChange: (state) => states.push(state),
    onError: (error, input) => failures.push({ error, input }),
  });
  return { pump, scheduled, requests, events, states, failures };
}

describe("LiveInputPump", () => {
  test("shows local text immediately and sends the leading batch on the next paint", () => {
    const run = harness();
    expect(run.pump.enqueue("h")).toBeTrue();
    expect(run.pump.enqueue("i")).toBeTrue();
    expect(run.requests).toHaveLength(0);
    expect(run.pump.snapshot().visibleText).toBe("hi");
    expect(run.scheduled).toHaveLength(1);

    run.scheduled.shift()!();
    expect(run.requests.map((item) => item.text)).toEqual(["hi"]);
    expect(run.events).toEqual(["send:hi", "read"]);
  });

  test("queues PaneRead directly after SendText and does not wait for it before the next batch", async () => {
    const run = harness();
    run.pump.enqueue("a");
    run.scheduled.shift()!();
    run.pump.enqueue("bc");
    expect(run.pump.snapshot().visibleText).toBe("abc");

    run.requests[0].done.resolve();
    await microtasks();
    expect(run.requests.map((item) => item.text)).toEqual(["a", "bc"]);
    expect(run.events).toEqual(["send:a", "read", "send:bc", "read"]);
  });

  test("flush waits for all text before allowing Enter", async () => {
    const run = harness();
    run.pump.enqueue("a");
    run.scheduled.shift()!();
    run.pump.enqueue("b");
    let flushed: boolean | undefined;
    void run.pump.flush().then((value) => { flushed = value; });

    run.requests[0].done.resolve();
    await microtasks();
    expect(flushed).toBeUndefined();
    expect(run.requests[1].text).toBe("b");
    run.requests[1].done.resolve();
    await microtasks();
    expect(flushed).toBeTrue();
  });

  test("stops after a failed mutation and returns unsent text without replaying it", async () => {
    const run = harness();
    run.pump.enqueue("sent?");
    run.scheduled.shift()!();
    run.pump.enqueue("unsent");
    const flushed = run.pump.flush();
    const error = new Error("unknown outcome");
    run.requests[0].done.reject(error);
    await microtasks();

    expect(await flushed).toBeFalse();
    expect(run.failures).toEqual([{ error, input: { failedText: "sent?", queuedText: "unsent" } }]);
    expect(run.pump.enqueue("later")).toBeFalse();
    expect(run.requests).toHaveLength(1);
    expect(run.pump.snapshot().visibleText).toBe("");
  });

  test("stop drops scheduled input and ignores late acknowledgements", async () => {
    const run = harness();
    run.pump.enqueue("a");
    run.scheduled.shift()!();
    run.pump.enqueue("b");
    run.pump.stop();
    run.requests[0].done.resolve();
    await microtasks();
    expect(run.requests).toHaveLength(1);
    expect(run.pump.snapshot()).toMatchObject({ visibleText: "", busy: false, scheduled: false });
  });

  test("a read scheduling failure does not change the mutation outcome", async () => {
    const done = deferred();
    const errors: unknown[] = [];
    const pump = new LiveInputPump({
      schedule: (run) => { run(); return 1; },
      cancel: () => undefined,
      send: () => done.promise,
      requestRead: () => { throw new Error("read unavailable"); },
      onError: (error) => { errors.push(error); },
    });
    pump.enqueue("ok");
    const flushed = pump.flush();
    done.resolve();
    await microtasks();
    expect(await flushed).toBeTrue();
    expect(errors).toEqual([]);
  });
});
