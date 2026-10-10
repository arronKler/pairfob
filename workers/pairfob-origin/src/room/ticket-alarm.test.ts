import { describe, expect, spyOn, test } from "bun:test";
import { HELLO_GRACE_MS, TICKET_MS } from "../constants.ts";
import { makeRoom, PAIR_REF } from "../testutil/make-room.ts";

function ticket(h: ReturnType<typeof makeRoom>, id: string, deadline: number) {
  h.store.insertTicket({ ticket: id, pair_ref: PAIR_REF, deadline });
  h.store.upsertAlarm("ticket_15s", id, deadline);
}

describe("ticket alarm batches", () => {
  test("multiple due tickets share one expiry sweep while other alarm kinds still run", async () => {
    const h = makeRoom();
    const phone = h.accept("phone");
    if (!phone.ok) throw new Error("phone upgrade failed");
    h.store.upsertAlarm("hello_5s", "silent-phone", h.clock.t + HELLO_GRACE_MS);
    h.tick(HELLO_GRACE_MS);
    const now = h.clock.t;
    for (const id of ["first", "second", "third"]) ticket(h, id, now);
    ticket(h, "future", now + TICKET_MS);
    const expire = spyOn(h.store, "expireTickets");
    try {
      await h.core.alarm();
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenCalledWith(now);
      expect(phone.ws.closed).toBe(true);
      expect(phone.ws.closeReason).toBe("unbound");
      for (const id of ["first", "second", "third"]) {
        // Looking before the deadline distinguishes deletion from expiry filtering.
        expect(h.store.consumeTicket(id, now - 1)).toBeNull();
      }
      expect(h.store.listAlarms()).toHaveLength(1);
      expect(await h.store.getAlarm()).toBe(now + TICKET_MS);
      expect(h.store.consumeTicket("future", now)?.ticket).toBe("future");
    } finally {
      expire.mockRestore();
    }
  });

  test("ticket expiry happens exactly at its deadline", async () => {
    const h = makeRoom();
    const deadline = h.clock.t + TICKET_MS;
    ticket(h, "due", deadline);
    h.tick(TICKET_MS - 1);
    await h.core.alarm();
    expect(h.store.dueAlarms(h.clock.t)).toEqual([]);
    expect(h.store.listAlarms()).toHaveLength(1);
    expect(await h.store.getAlarm()).toBe(deadline);
    h.tick(1);
    await h.core.alarm();
    expect(h.store.consumeTicket("due", deadline - 1)).toBeNull();
    expect(h.store.listAlarms()).toEqual([]);
    expect(await h.store.getAlarm()).toBeNull();
  });

  test("a ticket issued while another due alarm awaits I/O survives the batch", async () => {
    const h = makeRoom();
    const originalIndex = h.core.deps.index!;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.core.deps.index = {
      ...originalIndex,
      remove: async (loc, owner) => {
        entered();
        await gate;
        await originalIndex.remove(loc, owner);
      },
    };
    h.store.putSlot({ pair_ref: PAIR_REF, pair_loc: "ABCDEF", deadline: h.clock.t });
    h.store.upsertAlarm("pair_ttl", PAIR_REF, h.clock.t);
    ticket(h, "old", h.clock.t);
    const expiredAt = h.clock.t;
    const expire = spyOn(h.store, "expireTickets");
    try {
      const alarm = h.core.alarm();
      await waiting;
      h.tick(1);
      // A replacement pairing is now available while the old index removal yields.
      h.store.putSlot({ pair_ref: "55".repeat(16), pair_loc: "GHJKMN", deadline: h.clock.t + 60_000 });
      const issued = await h.core.issueTicket("GHJKMN");
      release();
      await alarm;
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error("new ticket was not issued");
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenCalledWith(expiredAt);
      expect(h.store.consumeTicket("old", expiredAt - 1)).toBeNull();
      expect(h.store.consumeTicket(issued.pair_ticket, h.clock.t)?.pair_ref).toBe("55".repeat(16));
      expect(h.store.listAlarms()).toHaveLength(1);
      expect(await h.store.getAlarm()).toBe(h.clock.t + TICKET_MS);
      expect(h.store.loadSlot()?.pair_loc).toBe("GHJKMN");
    } finally {
      release();
      expire.mockRestore();
    }
  });
});
