import { describe, expect, test } from "bun:test";

import { FullTerminalOpenTracker } from "./full-terminal-open-tracker";

describe("complete-terminal open tracking", () => {
  test("shares an in-flight open and exposes it to teardown", async () => {
    const tracker = new FullTerminalOpenTracker();
    let release = () => {};
    let calls = 0;
    const first = tracker.run(() => {
      calls++;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const second = tracker.run(async () => { calls++; });
    let settled = false;
    void tracker.pending().then(() => { settled = true; });

    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(settled).toBeFalse();
    release();
    await first;
    expect(settled).toBeTrue();
  });

  test("allows a later open after either fulfillment or rejection", async () => {
    const tracker = new FullTerminalOpenTracker();
    await tracker.run(async () => undefined);
    await Promise.resolve();
    await expect(tracker.run(async () => { throw new Error("open failed"); })).rejects.toThrow("open failed");
    await Promise.resolve();
    await expect(tracker.run(async () => undefined)).resolves.toBeUndefined();
  });
});
