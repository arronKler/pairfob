import { describe, expect, test } from "bun:test";

import { confirmPaneChange, PANE_CHANGE_RETRY_DELAYS_MS } from "./pane-change-confirmation";
import type { PaneReadObservation } from "./pane-refresh-request";

function observation(hash: string, startedAt: number, completedAt: number, text = "screen"): PaneReadObservation {
  return { paneId: "p1", text, hash, changed: hash !== "old", startedAt, completedAt };
}

describe("post-mutation pane confirmation", () => {
  test("stops as soon as a bounded read observes a new hash", async () => {
    const reads = [observation("old", 101, 110), observation("new", 190, 200)];
    const delays: number[] = [];
    const notBefore: number[] = [];
    const result = await confirmPaneChange({
      paneId: "p1",
      baselineHash: "old",
      baselineText: "screen",
      mutationAckAt: 100,
      read: async (request) => {
        notBefore.push(request.notBefore ?? -1);
        return reads.shift() ?? null;
      },
      isCurrent: () => true,
      sleep: async (delay) => { delays.push(delay); },
    });

    expect(result).toEqual({ result: "changed", attempts: 2, firstReadStartedAt: 101, changedAt: 200 });
    expect(delays).toEqual([PANE_CHANGE_RETRY_DELAYS_MS[0]]);
    expect(notBefore).toEqual([100, 110]);
  });

  test("expires a no-op page key without replaying the mutation", async () => {
    let reads = 0;
    const delays: number[] = [];
    const result = await confirmPaneChange({
      paneId: "p1",
      baselineHash: "old",
      baselineText: "screen",
      mutationAckAt: 100,
      read: async () => observation("old", 101 + reads * 10, 105 + reads++ * 10),
      isCurrent: () => true,
      sleep: async (delay) => { delays.push(delay); },
    });

    expect(result.result).toBe("unchanged");
    expect(result.attempts).toBe(PANE_CHANGE_RETRY_DELAYS_MS.length + 1);
    expect(delays).toEqual([...PANE_CHANGE_RETRY_DELAYS_MS]);
  });

  test("cancels when the user leaves the pane", async () => {
    let current = true;
    const result = await confirmPaneChange({
      paneId: "p1",
      baselineHash: "old",
      baselineText: "screen",
      mutationAckAt: 100,
      read: async () => {
        current = false;
        return observation("new", 101, 110);
      },
      isCurrent: () => current,
      sleep: async () => undefined,
    });

    expect(result).toEqual({ result: "cancelled", attempts: 1, firstReadStartedAt: 101, changedAt: null });
  });

  test("falls back to text when no baseline hash exists", async () => {
    const result = await confirmPaneChange({
      paneId: "p1",
      baselineHash: "",
      baselineText: "before",
      mutationAckAt: 100,
      read: async () => observation("", 101, 110, "after"),
      isCurrent: () => true,
      sleep: async () => undefined,
    });
    expect(result.result).toBe("changed");
    expect(result.attempts).toBe(1);
  });
});
