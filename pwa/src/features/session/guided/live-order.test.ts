import { describe, expect, test } from "bun:test";
import { LiveOrder, type LivePath } from "./live-order";

/** A path that holds what it is given until `write()` is called, as the pump does behind a slow write. */
function path(log: string[]) {
  let held: string[] = [];
  let waiters: Array<() => void> = [];
  const api: LivePath & { hold: boolean; give(unit: string): void; write(): void } = {
    hold: false,
    unsent: () => held.length > 0,
    written: () => held.length ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
    give(unit) {
      if (api.hold) held.push(unit);
      else log.push(unit);
    },
    write() {
      log.push(...held);
      held = [];
      for (const resolve of waiters.splice(0)) resolve();
    },
  };
  return api;
}

const turns = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

function order() {
  const log: string[] = [];
  const text = path(log);
  const keys = path(log);
  const wheel = path(log);
  const live = new LiveOrder(new Map<string, LivePath>([["text", text], ["keys", keys], ["wheel", wheel]]));
  return {
    log, text, keys, wheel, live,
    type: (unit: string) => live.submit("text", () => text.give(unit)),
    press: (unit: string) => live.submit("keys", () => keys.give(unit)),
    scroll: (unit: string) => live.submit("wheel", () => wheel.give(unit)),
  };
}

describe("everything typed in live input is written in the order it was typed", () => {
  test("with nothing held back a key and a character go at once", () => {
    const { log, live, type, press } = order();
    type("a");
    press("⌫");
    type("b");
    expect(log).toEqual(["a", "⌫", "b"]);
    expect(live.waiting()).toBeFalse();
  });

  test("a key waits for a character the pump is still holding, and what is typed after it waits behind the key", async () => {
    const { log, text, live, type, press } = order();
    type("a");
    // The first write has not been acknowledged: the pump holds what follows.
    text.hold = true;
    type("b");
    press("⌫");
    type("c");
    press("⏎");
    expect(log).toEqual(["a"]);
    expect(live.waiting()).toBeTrue();
    text.write();
    await turns();
    // `c` goes to the pump in its turn, behind the key; the pump is still slow.
    expect(log).toEqual(["a", "b", "⌫"]);
    text.write();
    await turns();
    expect(log).toEqual(["a", "b", "⌫", "c", "⏎"]);
    expect(live.waiting()).toBeFalse();
  });

  test("a character waits for keys the key queue is still holding", async () => {
    const { log, keys, type, press } = order();
    press("↑");
    keys.hold = true;
    press("↑");
    type("x");
    expect(log).toEqual(["↑"]);
    keys.write();
    await turns();
    expect(log).toEqual(["↑", "↑", "x"]);
  });

  test("nothing waits for an answer: a key follows text that has been written but not acknowledged", () => {
    const { log, type, press } = order();
    // Written and in flight: the path holds nothing back.
    type("ls");
    press("⇥");
    expect(log).toEqual(["ls", "⇥"]);
  });

  test("a reset drops what is waiting, so an Enter never arrives without the command that failed", async () => {
    const { log, text, live, type, press } = order();
    text.hold = true;
    type("rm -rf build");
    press("⏎");
    live.reset();
    text.hold = false;
    text.write();
    await turns();
    expect(log).toEqual(["rm -rf build"]);
    expect(live.waiting()).toBeFalse();
    // And the next thing typed is not held up by what was dropped.
    press("⌫");
    expect(log).toEqual(["rm -rf build", "⌫"]);
  });

  test("a unit that writes directly (a page key) waits for every path, and what follows waits for it to have written", async () => {
    const { log, text, keys, live, type, press } = order();
    type("a");
    text.hold = true;
    type("b");
    // PageUp: no path of its own, written by its turn itself, and only after the keys before it settled.
    let settle = () => {};
    live.submit(null, () => new Promise<void>((resolve) => { settle = () => { log.push("⇞"); resolve(); }; }));
    type("c");
    press("⏎");
    text.write();
    await turns();
    // Its turn has come, but it has not written yet: nothing passes it.
    expect(log).toEqual(["a", "b"]);
    settle();
    await turns();
    text.write();
    await turns();
    expect(log).toEqual(["a", "b", "⇞", "c", "⏎"]);
    expect(keys.unsent()).toBeFalse();
    expect(live.waiting()).toBeFalse();
  });

  test("with nothing held a direct unit runs at once, and still holds what is typed while it writes", async () => {
    const { log, live, type } = order();
    let settle = () => {};
    live.submit(null, () => new Promise<void>((resolve) => { settle = () => { log.push("⇟"); resolve(); }; }));
    type("x");
    expect(log).toEqual([]);
    expect(live.waiting()).toBeTrue();
    settle();
    await turns();
    expect(log).toEqual(["⇟", "x"]);
  });

  test("a wheel notch whose bridge is still opening keeps the key pressed after it behind it", async () => {
    const { log, wheel, scroll, press, type } = order();
    wheel.hold = true;
    scroll("wheel↑");
    press("q");
    type("x");
    expect(log).toEqual([]);
    wheel.write();
    await turns();
    expect(log).toEqual(["wheel↑", "q", "x"]);
  });

  test("a unit dropped by a reset is told, in the order it was typed; `drained` waits for the rest", async () => {
    const { log, text, live, type, press } = order();
    text.hold = true;
    type("a");
    const lost: string[] = [];
    live.submit("keys", () => log.push("⌫"), () => lost.push("⌫"));
    live.submit("text", () => log.push("c"), () => lost.push("c"));
    live.reset();
    expect(lost).toEqual(["⌫", "c"]);
    expect(live.waiting()).toBeFalse();
    text.hold = false;
    text.write();
    // Nothing waits any more: a drain settles at once, and one asked for while a unit waits settles after it.
    await live.drained();
    text.hold = true;
    type("d");
    press("⏎");
    let done = false;
    void live.drained().then(() => { done = true; });
    await turns();
    expect(done).toBeFalse();
    text.write();
    await turns();
    expect(done).toBeTrue();
    expect(log).toEqual(["a", "d", "⏎"]);
  });

  test("a unit that throws does not stall the ones behind it", async () => {
    const { log, text, live, type } = order();
    text.hold = true;
    type("a");
    live.submit("keys", () => { throw new Error("pane closed"); });
    live.submit("keys", () => log.push("⏎"));
    text.write();
    await turns();
    expect(log).toEqual(["a", "⏎"]);
  });
});
