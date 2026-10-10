import { describe, expect, test } from "bun:test";
import { CfStore } from "./cf-store.ts";
import { makeRoom } from "../testutil/make-room.ts";
import { newAttachment } from "./attachment.ts";

function clockedStore(current: number | null, now = 10_000) {
  const writes: number[] = [];
  const repairs: number[][] = [];
  let deletes = 0;
  const storage = {
    getAlarm: async () => current,
    setAlarm: async (at: number) => { current = at; writes.push(at); },
    deleteAlarm: async () => { current = null; deletes++; },
  } as unknown as DurableObjectStorage;
  const store = new CfStore(storage, () => now, (...args) => { repairs.push(args); });
  return { store, writes, repairs, deletes: () => deletes };
}

describe("abandoned alarm recovery", () => {
  test("an unchanged overdue platform alarm is rearmed in the future", async () => {
    const h = clockedStore(100);
    await h.store.setAlarmIfChanged(100);
    expect(h.writes).toEqual([10_001]);
    expect(h.repairs).toEqual([[100, 100, 10_001]]);
  });

  test("an unchanged future alarm does not add writes", async () => {
    const h = clockedStore(20_000);
    await h.store.setAlarmIfChanged(20_000);
    expect(h.writes).toEqual([]);
  });

  test("a missing alarm with overdue work is scheduled after now", async () => {
    const h = clockedStore(null);
    await h.store.setAlarmIfChanged(100);
    expect(h.writes).toEqual([10_001]);
  });

  test("a deadline equal to now gets a distinct future timestamp", async () => {
    const h = clockedStore(10_000);
    await h.store.setAlarmIfChanged(10_000);
    expect(h.writes).toEqual([10_001]);
  });

  test("an empty queue clears a stale platform alarm", async () => {
    const h = clockedStore(100);
    await h.store.setAlarmIfChanged(null);
    expect(h.deletes()).toBe(1);
    expect(h.writes).toEqual([]);
  });

  test("an old backlog drains in bounded batches without closing current sessions", async () => {
    const h = makeRoom();
    const daemon = h.accept("daemon");
    const phone = h.accept("phone");
    const pending = h.accept("phone");
    if (!daemon.ok || !phone.ok || !pending.ok) throw new Error("upgrade failed");
    daemon.ws.serializeAttachment(newAttachment("daemon", h.clock.t, { hello_at_ms: h.clock.t }));
    phone.ws.serializeAttachment(newAttachment("phone", h.clock.t, { mode: "session", kind: "established" }));
    pending.ws.serializeAttachment(newAttachment("phone", h.clock.t - 60_000));
    for (let i = 0; i < 300; i++) h.store.upsertAlarm("hello_5s", `old-${i}`, h.clock.t - 10_000 + i);
    const future = h.clock.t + 60_000;
    h.store.upsertAlarm("hello_5s", "future", future);
    for (const remaining of [173, 45, 1]) {
      await h.core.alarm();
      expect(h.store.listAlarms()).toHaveLength(remaining);
      expect(daemon.ws.closed).toBe(false);
      expect(phone.ws.closed).toBe(false);
    }
    expect(pending.ws.closed).toBe(true);
    expect(await h.store.getAlarm()).toBe(future);
  });
});
