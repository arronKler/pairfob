import { describe, expect, test } from "bun:test";
import { TransportSwitchBarrier } from "./transport-switch.ts";

describe("transport switch ownership", () => {
  test("a settled attempt cannot release a newer attempt's mutation barrier", async () => {
    const barrier = new TransportSwitchBarrier();
    const first = barrier.begin();
    expect(barrier.end(first)).toBe(true);

    const second = barrier.begin();
    let released = false;
    void barrier.wait()?.then(() => { released = true; });
    expect(barrier.end(first)).toBe(false);
    await Promise.resolve();
    expect(released).toBe(false);
    expect(barrier.owns(second)).toBe(true);

    expect(barrier.end(second)).toBe(true);
    await Promise.resolve();
    expect(released).toBe(true);
  });
});
