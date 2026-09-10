import { describe, expect, test } from "bun:test";
import type { LiveSession } from "../../lib/protocol/session-types";
import { createPaneReadLane, type PaneReadOwner } from "./pane-read";

function session(id: string): LiveSession {
  return { id } as unknown as LiveSession;
}

function owner(over: Partial<PaneReadOwner> = {}): PaneReadOwner {
  return {
    session: session("a"),
    viewVersion: 1,
    paneId: "p1",
    incarnation: 1,
    mode: "guided",
    ...over,
  };
}

describe("pane-read lane", () => {
  test("a later generation replaces a queued read and resolves the old one null", async () => {
    const busy: boolean[] = [];
    let pending = false;
    const lane = createPaneReadLane({
      perform: async (target) => ({
        paneId: target.paneId,
        text: String(target.viewVersion),
        hash: String(target.viewVersion),
        changed: true,
        startedAt: 1,
        completedAt: 2,
      }),
      deferPane: () => undefined,
      setBusy: (value) => {
        busy.push(value);
      },
      setPending: (value) => {
        pending = value;
      },
      now: () => 1,
    });
    const a = session("a");
    const first = lane.request(owner({ session: a, paneId: "p1", viewVersion: 1 }), {});
    const stale = lane.request(owner({ session: a, paneId: "p2", viewVersion: 1 }), {});
    const next = lane.request(owner({ session: a, paneId: "p2", viewVersion: 2 }), {});
    expect(await stale).toBeNull();
    expect(await first).toEqual({
      paneId: "p1",
      text: "1",
      hash: "1",
      changed: true,
      startedAt: 1,
      completedAt: 2,
    });
    expect(await next).toEqual({
      paneId: "p2",
      text: "2",
      hash: "2",
      changed: true,
      startedAt: 1,
      completedAt: 2,
    });
    expect(pending).toBe(false);
    expect(busy[0]).toBe(true);
  });

  test("reset resolves a queued owner and clears occupancy", async () => {
    let release!: () => void;
    const lane = createPaneReadLane({
      perform: () => new Promise((resolve) => {
        release = () => resolve(null);
      }),
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => 1,
    });
    const a = session("a");
    const flight = lane.request(owner({ session: a, paneId: "p1" }), {});
    const queued = lane.request(owner({ session: a, paneId: "p2" }), {});
    lane.reset();
    expect(await queued).toBeNull();
    release();
    expect(await flight).toBeNull();
  });

  test("an old finalizer cannot clear a replacement flight after start/stop/start", async () => {
    let finishOld!: (value: null) => void;
    let performs = 0;
    const lane = createPaneReadLane({
      perform: (target) => {
        performs += 1;
        if (performs === 1) {
          return new Promise((resolve) => {
            finishOld = () => resolve(null);
          });
        }
        return Promise.resolve({
          paneId: target.paneId,
          text: "new",
          hash: "n",
          changed: true,
          startedAt: 2,
          completedAt: 3,
        });
      },
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => performs + 1,
    });
    const old = lane.request(owner({ incarnation: 1 }), {});
    lane.reset();
    const fresh = lane.request(owner({ incarnation: 2 }), {});
    finishOld(null);
    expect(await old).toBeNull();
    expect(await fresh).toMatchObject({ text: "new" });
  });

  test("notBefore refuses a flight that started too early", async () => {
    let now = 1;
    const lane = createPaneReadLane({
      perform: async (target, startedAt) => ({
        paneId: target.paneId,
        text: String(startedAt),
        hash: String(startedAt),
        changed: true,
        startedAt,
        completedAt: startedAt + 1,
      }),
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => now,
    });
    const first = lane.request(owner(), {});
    now = 10;
    const next = lane.request(owner(), { notBefore: 5 });
    expect(await first).toMatchObject({ text: "1" });
    expect(await next).toMatchObject({ text: "10" });
  });

  test("a mode replacement does not reuse a guided flight", async () => {
    const paneIds: string[] = [];
    const lane = createPaneReadLane({
      perform: async (target) => {
        paneIds.push(target.mode);
        return {
          paneId: target.paneId,
          text: target.mode,
          hash: target.mode,
          changed: true,
          startedAt: 1,
          completedAt: 2,
        };
      },
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => 1,
    });
    const guided = lane.request(owner({ mode: "guided" }), {});
    const agent = lane.request(owner({ mode: "agent" }), {});
    expect(await guided).toMatchObject({ text: "guided" });
    expect(await agent).toMatchObject({ text: "agent" });
    expect(paneIds).toEqual(["guided", "agent"]);
  });

  test("a setBusy subscriber requesting another pane queues behind the reserved flight", async () => {
    const started: string[] = [];
    let releaseFirst!: (observation: import("./refresh-request").PaneReadObservation | null) => void;
    const a = session("a");
    const p1 = owner({ session: a, paneId: "p1" });
    const p2 = owner({ session: a, paneId: "p2" });
    const lane = createPaneReadLane({
      perform: (target) => {
        started.push(target.paneId);
        if (target.paneId === "p1") {
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve(null);
      },
      deferPane: () => undefined,
      setBusy: (busy) => {
        if (busy) void lane.request(p2, {});
      },
      setPending: () => undefined,
      now: () => 1,
    });
    const first = lane.request(p1, {});
    // Only p1 is in flight: the reentrant p2 request saw the reserved flight.
    expect(started).toEqual(["p1"]);
    releaseFirst({ paneId: "p1", text: "t", hash: "h", changed: true, startedAt: 1, completedAt: 2 });
    await first;
    expect(started).toEqual(["p1", "p2"]);
  });

  test("a same-owner request during perform shares the real observation", async () => {
    const shared: Array<import("./refresh-request").PaneReadObservation | null> = [];
    const a = session("a");
    const p1 = owner({ session: a, paneId: "p1" });
    const lane = createPaneReadLane({
      perform: (target) => {
        if (target.paneId === "p1") {
          void lane.request(p1, {}).then((observation) => shared.push(observation));
          return Promise.resolve({
            paneId: "p1",
            text: "real",
            hash: "r",
            changed: true,
            startedAt: 1,
            completedAt: 2,
          });
        }
        return Promise.resolve(null);
      },
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => 1,
    });
    const first = await lane.request(p1, {});
    expect(first?.text).toBe("real");
    expect(shared).toEqual([expect.objectContaining({ text: "real" })]);
  });

  test("a synchronous perform throw clears only its own flight and the lane recovers", async () => {
    let calls = 0;
    const lane = createPaneReadLane({
      perform: (target) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return Promise.resolve({
          paneId: target.paneId,
          text: "ok",
          hash: "h",
          changed: true,
          startedAt: 1,
          completedAt: 2,
        });
      },
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => 1,
    });
    let threw = false;
    try {
      await lane.request(owner({ paneId: "p1" }), {});
    } catch {
      threw = true;
    }
    // The lane was not wedged: the next request starts a fresh flight.
    const second = await lane.request(owner({ paneId: "p2" }), {});
    expect(threw).toBe(true);
    expect(second).toMatchObject({ text: "ok", paneId: "p2" });
    expect(calls).toBe(2);
  });

  test("a caller mutating its owner object cannot retarget an in-flight read", async () => {
    const performed: string[] = [];
    const lane = createPaneReadLane({
      perform: (target) => {
        performed.push(target.paneId);
        return Promise.resolve(null);
      },
      deferPane: () => undefined,
      setBusy: () => undefined,
      setPending: () => undefined,
      now: () => 1,
    });
    const target = owner({ paneId: "p1" });
    const done = lane.request(target, {});
    target.paneId = "poison";
    await done;
    expect(performed).toEqual(["p1"]);
  });

  test("completion cannot let an old queued request displace a newer one queued by the subscriber", async () => {
    const a = session("a");
    const gates: Array<{ paneId: string; release: (o: import("./refresh-request").PaneReadObservation | null) => void }> = [];
    const starts: string[] = [];
    let reentered = false;
    let newerFlight!: Promise<import("./refresh-request").PaneReadObservation | null>;
    let newerQueued!: Promise<import("./refresh-request").PaneReadObservation | null>;
    const lane = createPaneReadLane({
      perform: (target) => {
        starts.push(target.paneId);
        return new Promise((resolve) => {
          gates.push({ paneId: target.paneId, release: resolve });
        });
      },
      deferPane: () => undefined,
      setBusy: (busy) => {
        if (busy || reentered) return;
        reentered = true;
        newerFlight = lane.request(owner({ session: a, paneId: "p3" }), {});
        newerQueued = lane.request(owner({ session: a, paneId: "p4" }), {});
      },
      setPending: () => undefined,
      now: () => 1,
    });
    const first = lane.request(owner({ session: a, paneId: "p1" }), {});
    const olderQueued = lane.request(owner({ session: a, paneId: "p2" }), {});
    for (let i = 0; i < 10; i += 1) {
      for (const gate of gates) {
        gate.release({ paneId: gate.paneId, text: "t", hash: "h", changed: true, startedAt: 1, completedAt: 2 });
      }
      await Promise.resolve();
    }
    const values = await Promise.all([first, olderQueued, newerFlight, newerQueued]);
    lane.reset();
    // The newer request made during the old completion keeps priority; the old
    // queued request this finalizer carried is obsolete.
    expect(starts).toEqual(["p1", "p3", "p4"]);
    expect(values[1]).toBeNull();
    expect(values[3]?.paneId).toBe("p4");
  });

  test("a reset during the reserved-flight busy publication retires the continuation before perform", async () => {
    const a = session("a");
    let retired = false;
    let performed = 0;
    const lane = createPaneReadLane({
      perform: async () => {
        performed += 1;
        return { paneId: "p1", text: "t", hash: "h", changed: true, startedAt: 1, completedAt: 2 };
      },
      deferPane: () => undefined,
      setBusy: (busy) => {
        if (busy && !retired) {
          retired = true;
          lane.reset();
        }
      },
      setPending: () => undefined,
      now: () => 1,
    });
    const done = await lane.request(owner({ session: a }), {});
    lane.reset();
    expect(done).toBeNull();
    expect(performed).toBe(0);
  });

  test("a reset during completion settles the carried queued promise without restarting it", async () => {
    const a = session("a");
    const starts: string[] = [];
    const gates: Array<{ paneId: string; release: (o: import("./refresh-request").PaneReadObservation) => void }> = [];
    let reset = false;
    const lane = createPaneReadLane({
      perform: (target) => {
        starts.push(target.paneId);
        return new Promise((resolve) => {
          gates.push({ paneId: target.paneId, release: resolve });
        });
      },
      deferPane: () => undefined,
      setBusy: (busy) => {
        if (busy || reset) return;
        reset = true;
        lane.reset();
      },
      setPending: () => undefined,
      now: () => 1,
    });
    const first = lane.request(owner({ session: a, paneId: "p1" }), {});
    const queued = lane.request(owner({ session: a, paneId: "p2" }), {});
    for (let i = 0; i < 10; i += 1) {
      for (const gate of gates) {
        gate.release({ paneId: gate.paneId, text: "t", hash: "h", changed: true, startedAt: 1, completedAt: 2 });
      }
      await Promise.resolve();
    }
    const results = await Promise.all([first, queued]);
    lane.reset();
    // The carried p2 was already retired by the reset during completion: it
    // must not restart, and its actual promise settles null.
    expect(results[0]?.paneId).toBe("p1");
    expect(starts).toEqual(["p1"]);
    expect(results[1]?.paneId ?? null).toBeNull();
  });
});
