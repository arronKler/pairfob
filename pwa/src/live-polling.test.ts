import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

import { createLivePolling } from "./live-polling";
import { SNAPSHOT_FALLBACK_MS } from "./poll";

const PANE_FALLBACK_MS = 1_500;
const PANE_IDLE_MS = 6_000;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

type TimerEntry = { callback: () => unknown; delay: number };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function installTimers() {
  const originalWindow = globalThis.window;
  const timers = new Map<number, TimerEntry>();
  let nextTimer = 0;
  const happy = new Window({ url: "https://pairfob.com/pair" });
  happy.setTimeout = ((callback: () => unknown, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay: Number(delay) });
    return id;
  }) as typeof happy.setTimeout;
  happy.clearTimeout = ((id: number) => {
    timers.delete(Number(id));
  }) as typeof happy.clearTimeout;
  globalThis.window = happy as unknown as Window & typeof globalThis;
  return {
    timers,
    restore(): void {
      globalThis.window = originalWindow;
    },
    fire(id: number): Promise<void> {
      const entry = timers.get(id);
      if (!entry) throw new Error(`missing timer ${id}`);
      timers.delete(id);
      return Promise.resolve(entry.callback());
    },
    ofDelay(delay: number): Array<[number, TimerEntry]> {
      return [...timers].filter(([, timer]) => timer.delay === delay);
    },
    pane(): Array<[number, TimerEntry]> {
      return [...timers].filter(([, timer]) => timer.delay !== SNAPSHOT_FALLBACK_MS);
    },
    snapshot(): Array<[number, TimerEntry]> {
      return [...timers].filter(([, timer]) => timer.delay === SNAPSHOT_FALLBACK_MS);
    },
  };
}

type Clock = ReturnType<typeof installTimers>;

function beginPaneTick(clock: Clock): Promise<void> {
  const scheduled = clock.pane();
  expect(scheduled).toHaveLength(1);
  return clock.fire(scheduled[0][0]);
}

function beginSnapshotTick(clock: Clock): Promise<void> {
  const scheduled = clock.snapshot();
  expect(scheduled).toHaveLength(1);
  return clock.fire(scheduled[0][0]);
}

function expectSingleDelay(entries: Array<[number, TimerEntry]>, delay: number): void {
  expect(entries).toHaveLength(1);
  expect(entries[0][1].delay).toBe(delay);
}

type FlightKind = { calls: number; active: number; maxActive: number; flight: Deferred };

function trackFlight(kind: FlightKind): () => Promise<void> {
  return async () => {
    kind.calls += 1;
    kind.active += 1;
    kind.maxActive = Math.max(kind.maxActive, kind.active);
    try {
      await kind.flight.promise;
    } finally {
      kind.active -= 1;
    }
  };
}

function createFlights() {
  const pane: FlightKind = { calls: 0, active: 0, maxActive: 0, flight: deferred() };
  const snapshot: FlightKind = { calls: 0, active: 0, maxActive: 0, flight: deferred() };
  const settle = (kind: FlightKind): void => {
    const current = kind.flight;
    kind.flight = deferred();
    current.resolve();
  };
  const fail = (kind: FlightKind, reason: unknown): void => {
    const current = kind.flight;
    kind.flight = deferred();
    current.reject(reason);
  };
  return {
    pane,
    snapshot,
    settlePane: () => settle(pane),
    settleSnapshot: () => settle(snapshot),
    failPane: (reason: unknown) => fail(pane, reason),
    failSnapshot: (reason: unknown) => fail(snapshot, reason),
    callbacks(gates?: { canRun?: () => boolean; canReadPane?: () => boolean; paneDelayMs?: () => number }) {
      return {
        canRun: gates?.canRun ?? (() => true),
        canReadPane: gates?.canReadPane ?? (() => true),
        paneDelayMs: gates?.paneDelayMs ?? (() => PANE_FALLBACK_MS),
        refreshSnapshot: trackFlight(snapshot),
        refreshPane: trackFlight(pane),
      };
    },
  };
}

describe("live pane fallback scheduling", () => {
  test("defers a pending fallback after an explicit confirmation read", () => {
    const clock = installTimers();
    try {
      const polling = createLivePolling({
        canRun: () => true,
        canReadPane: () => true,
        paneDelayMs: () => PANE_FALLBACK_MS,
        refreshSnapshot: async () => undefined,
        refreshPane: async () => undefined,
      });
      polling.start();
      const firstPane = clock.ofDelay(PANE_FALLBACK_MS)[0]?.[0];
      expect(firstPane).toBeNumber();

      polling.deferPane();
      expect(clock.timers.has(firstPane!)).toBe(false);
      expect(clock.ofDelay(PANE_FALLBACK_MS)).toHaveLength(1);

      polling.wakePane();
      expect(clock.ofDelay(0)).toHaveLength(1);
      polling.stop();
    } finally {
      clock.restore();
    }
  });
});

describe("pane scheduler ownership", () => {
  test("repeated wake and defer while a pane read is pending keep one timer and one flight", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      expect(clock.pane()).toHaveLength(1);
      expect(clock.snapshot()).toHaveLength(1);

      const first = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(1);
      expect(clock.pane()).toHaveLength(0);

      for (let i = 0; i < 5; i++) {
        polling.wakePane();
        polling.deferPane();
        polling.wakePane();
        expect(clock.pane()).toHaveLength(0);
        expect(flights.pane.calls).toBe(1);
      }

      flights.settlePane();
      await first;
      expectSingleDelay(clock.pane(), 0);
      expect(flights.pane.calls).toBe(1);

      const second = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(2);
      expect(clock.pane()).toHaveLength(0);
      flights.settlePane();
      await second;
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      polling.stop();
      expect(clock.pane()).toHaveLength(0);
    } finally {
      clock.restore();
    }
  });

  test("defer during a slow pane read pushes fallback instead of an urgent follow-up", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const pending = beginPaneTick(clock);
      polling.wakePane();
      polling.deferPane();
      expect(clock.pane()).toHaveLength(0);
      flights.settlePane();
      await pending;
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("wake while idle replaces the fallback timer with an urgent one", () => {
    const clock = installTimers();
    try {
      const polling = createLivePolling({
        canRun: () => true,
        canReadPane: () => true,
        paneDelayMs: () => PANE_FALLBACK_MS,
        refreshSnapshot: async () => undefined,
        refreshPane: async () => undefined,
      });
      polling.start();
      const fallback = clock.ofDelay(PANE_FALLBACK_MS)[0]?.[0];
      polling.wakePane();
      expect(clock.timers.has(fallback!)).toBe(false);
      expectSingleDelay(clock.pane(), 0);
      polling.deferPane();
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("stop then start while a pane read is pending ignores the old completion", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const stale = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(1);

      polling.stop();
      expect(clock.pane()).toHaveLength(0);
      expect(clock.snapshot()).toHaveLength(0);
      polling.start();
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      expect(clock.snapshot()).toHaveLength(1);
      const nextPaneId = clock.pane()[0][0];

      flights.settlePane();
      await stale;
      expect(flights.pane.calls).toBe(1);
      expect(flights.pane.maxActive).toBe(1);
      expect(clock.pane().map(([id]) => id)).toEqual([nextPaneId]);
      expect(clock.pane()[0][1].delay).toBe(PANE_FALLBACK_MS);

      const next = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(2);
      flights.settlePane();
      await next;
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("a restarted pane timer that fires before the old read completes waits instead of overlapping", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const stale = beginPaneTick(clock);
      polling.stop();
      polling.start();
      const restarted = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(1);
      expect(flights.pane.active).toBe(1);
      expect(clock.pane()).toHaveLength(0);

      polling.wakePane();
      polling.deferPane();
      polling.wakePane();
      expect(clock.pane()).toHaveLength(0);
      expect(flights.pane.calls).toBe(1);

      flights.settlePane();
      await stale;
      expect(flights.pane.calls).toBe(2);
      expect(flights.pane.maxActive).toBe(1);
      expect(clock.pane()).toHaveLength(0);

      flights.settlePane();
      await restarted;
      expectSingleDelay(clock.pane(), 0);
      expect(flights.pane.maxActive).toBe(1);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("wake and defer are no-ops after stop, including while a stale read is finishing", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const stale = beginPaneTick(clock);
      polling.stop();
      polling.wakePane();
      polling.deferPane();
      expect(clock.pane()).toHaveLength(0);
      flights.settlePane();
      await stale;
      expect(clock.pane()).toHaveLength(0);
      expect(clock.snapshot()).toHaveLength(0);
      expect(flights.pane.calls).toBe(1);
    } finally {
      clock.restore();
    }
  });

  test("uses the current pane delay when arming after a flight", async () => {
    const clock = installTimers();
    const flights = createFlights();
    let paneDelay = PANE_FALLBACK_MS;
    try {
      const polling = createLivePolling(flights.callbacks({ paneDelayMs: () => paneDelay }));
      polling.start();
      const pending = beginPaneTick(clock);
      paneDelay = 10_000;
      polling.deferPane();
      flights.settlePane();
      await pending;
      expectSingleDelay(clock.pane(), 10_000);
      polling.stop();
    } finally {
      clock.restore();
    }
  });
});

describe("snapshot scheduler ownership", () => {
  test("a slow snapshot read keeps a single snapshot timer", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const pending = beginSnapshotTick(clock);
      expect(flights.snapshot.calls).toBe(1);
      expect(clock.snapshot()).toHaveLength(0);
      expect(clock.pane()).toHaveLength(1);

      flights.settleSnapshot();
      await pending;
      expectSingleDelay(clock.snapshot(), SNAPSHOT_FALLBACK_MS);
      expect(clock.pane()).toHaveLength(1);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("stop then start while a snapshot read is pending ignores the old completion", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const stale = beginSnapshotTick(clock);
      polling.stop();
      polling.start();
      const nextSnapshotId = clock.snapshot()[0][0];
      flights.settleSnapshot();
      await stale;
      expect(flights.snapshot.calls).toBe(1);
      expect(flights.snapshot.maxActive).toBe(1);
      expect(clock.snapshot().map(([id]) => id)).toEqual([nextSnapshotId]);

      const next = beginSnapshotTick(clock);
      expect(flights.snapshot.calls).toBe(2);
      flights.settleSnapshot();
      await next;
      expectSingleDelay(clock.snapshot(), SNAPSHOT_FALLBACK_MS);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("a restarted snapshot timer that fires before the old read completes waits instead of overlapping", async () => {
    const clock = installTimers();
    const flights = createFlights();
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const stale = beginSnapshotTick(clock);
      polling.stop();
      polling.start();
      const restarted = beginSnapshotTick(clock);
      expect(flights.snapshot.calls).toBe(1);
      expect(flights.snapshot.active).toBe(1);
      expect(clock.snapshot()).toHaveLength(0);

      flights.settleSnapshot();
      await stale;
      expect(flights.snapshot.calls).toBe(2);
      expect(flights.snapshot.maxActive).toBe(1);

      flights.settleSnapshot();
      await restarted;
      expectSingleDelay(clock.snapshot(), SNAPSHOT_FALLBACK_MS);
      expect(flights.snapshot.maxActive).toBe(1);
      polling.stop();
    } finally {
      clock.restore();
    }
  });
});

describe("run and visibility gates", () => {
  test("start is a no-op when canRun is false", () => {
    const clock = installTimers();
    try {
      const polling = createLivePolling({
        canRun: () => false,
        canReadPane: () => true,
        paneDelayMs: () => PANE_FALLBACK_MS,
        refreshSnapshot: async () => undefined,
        refreshPane: async () => undefined,
      });
      polling.start();
      expect(clock.timers.size).toBe(0);
      polling.wakePane();
      polling.deferPane();
      expect(clock.timers.size).toBe(0);
    } finally {
      clock.restore();
    }
  });

  test("a tick that cannot run skips the read and keeps both loops armed", async () => {
    const clock = installTimers();
    const flights = createFlights();
    let canRun = true;
    try {
      const polling = createLivePolling(flights.callbacks({ canRun: () => canRun }));
      polling.start();
      canRun = false;
      await beginPaneTick(clock);
      await beginSnapshotTick(clock);
      expect(flights.pane.calls).toBe(0);
      expect(flights.snapshot.calls).toBe(0);
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      expectSingleDelay(clock.snapshot(), SNAPSHOT_FALLBACK_MS);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("a pane tick that cannot read uses the idle delay and still snapshots", async () => {
    const clock = installTimers();
    const flights = createFlights();
    let canReadPane = false;
    try {
      const polling = createLivePolling(flights.callbacks({ canReadPane: () => canReadPane }));
      polling.start();
      expectSingleDelay(clock.pane(), PANE_IDLE_MS);
      await beginPaneTick(clock);
      expect(flights.pane.calls).toBe(0);
      expectSingleDelay(clock.pane(), PANE_IDLE_MS);

      const snapshot = beginSnapshotTick(clock);
      expect(flights.snapshot.calls).toBe(1);
      flights.settleSnapshot();
      await snapshot;
      expectSingleDelay(clock.snapshot(), SNAPSHOT_FALLBACK_MS);

      canReadPane = true;
      polling.wakePane();
      const pane = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(1);
      flights.settlePane();
      await pane;
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);
      polling.stop();
    } finally {
      clock.restore();
    }
  });

  test("start while already running replaces timers instead of stacking them", () => {
    const clock = installTimers();
    try {
      const polling = createLivePolling({
        canRun: () => true,
        canReadPane: () => true,
        paneDelayMs: () => PANE_FALLBACK_MS,
        refreshSnapshot: async () => undefined,
        refreshPane: async () => undefined,
      });
      polling.start();
      polling.start();
      expect(clock.pane()).toHaveLength(1);
      expect(clock.snapshot()).toHaveLength(1);
      polling.stop();
      expect(clock.timers.size).toBe(0);
    } finally {
      clock.restore();
    }
  });
});

describe("failed reads keep both loops alive", () => {
  test("a rejected pane read does not stop fallback or leave an unhandled rejection", async () => {
    const clock = installTimers();
    const flights = createFlights();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const polling = createLivePolling(flights.callbacks());
      polling.start();
      const pending = beginPaneTick(clock);
      flights.failPane(new Error("pane unavailable"));
      await pending;
      expect(unhandled).toEqual([]);
      expectSingleDelay(clock.pane(), PANE_FALLBACK_MS);

      const next = beginPaneTick(clock);
      expect(flights.pane.calls).toBe(2);
      flights.settlePane();
      await next;
      expect(unhandled).toEqual([]);
      polling.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      clock.restore();
    }
  });

  test("a thrown snapshot read does not stop either loop", async () => {
    const clock = installTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let snapshotCalls = 0;
      const polling = createLivePolling({
        canRun: () => true,
        canReadPane: () => true,
        paneDelayMs: () => PANE_FALLBACK_MS,
        refreshSnapshot: () => {
          snapshotCalls += 1;
          throw new Error("snapshot unavailable");
        },
        refreshPane: async () => undefined,
      });
      polling.start();
      await beginSnapshotTick(clock);
      expect(snapshotCalls).toBe(1);
      expect(unhandled).toEqual([]);
      expectSingleDelay(clock.snapshot(), SNAPSHOT_FALLBACK_MS);
      expect(clock.pane()).toHaveLength(1);

      await beginSnapshotTick(clock);
      expect(snapshotCalls).toBe(2);
      expect(unhandled).toEqual([]);
      polling.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      clock.restore();
    }
  });
});
