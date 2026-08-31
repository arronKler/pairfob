import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

import { createLivePolling } from "./live-polling";

describe("live pane fallback scheduling", () => {
  test("defers a pending fallback after an explicit confirmation read", () => {
    const happy = new Window({ url: "https://pairfob.com/pair" });
    const originalWindow = globalThis.window;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const cleared: number[] = [];
    let nextTimer = 0;
    happy.setTimeout = ((callback: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    }) as typeof happy.setTimeout;
    happy.clearTimeout = ((id: number) => {
      cleared.push(id);
      timers.delete(id);
    }) as typeof happy.clearTimeout;
    globalThis.window = happy as unknown as Window & typeof globalThis;
    try {
      const polling = createLivePolling({
        canRun: () => true,
        canReadPane: () => true,
        paneDelayMs: () => 1_500,
        refreshSnapshot: async () => undefined,
        refreshPane: async () => undefined,
      });
      polling.start();
      const firstPane = [...timers].find(([, timer]) => timer.delay === 1_500)?.[0];
      expect(firstPane).toBeNumber();

      polling.deferPane();
      expect(cleared).toContain(firstPane!);
      expect([...timers.values()].filter((timer) => timer.delay === 1_500)).toHaveLength(1);

      polling.wakePane();
      expect([...timers.values()].filter((timer) => timer.delay === 0)).toHaveLength(1);
      polling.stop();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
