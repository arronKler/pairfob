import { describe, expect, test } from "bun:test";
import { sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON } from "../frames.ts";
import { lastJSON, makeRoom } from "../testutil/make-room.ts";
import { IndexCore } from "../index/pairing-index.ts";
import type { PairIndexClient } from "./types.ts";
import { onMessage } from "./ws.ts";

async function registeredRoom() {
  const h = makeRoom();
  const token = "rt_" + "34".repeat(16);
  h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "34".repeat(8) });
  const daemon = h.accept("daemon").ws!;
  await onMessage(
    h.core,
    daemon,
    encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: h.core.daemonId,
      reconnect_token: token,
    }),
  );
  return { h, daemon };
}

function pairOpen(daemonId: string, pairRef: string): Uint8Array {
  return encodeJSON(Typ.PAIR_OPEN, ZERO_ROUTE, {
    v: 2,
    op: "CreatePairing",
    daemon_id: daemonId,
    pair_ref: pairRef,
    ttl_s: 180,
  });
}

describe("PAIR_OPEN serialization", () => {
  test("a stale owner cannot delete a locator that has been reissued", () => {
    const clock = { now: 1_000 };
    const index = new IndexCore(new Map(), () => clock.now);
    const loc = "ABCDEF";
    const oldOwner = { daemon_id: "d_" + "11".repeat(10), pair_ref: "11".repeat(16) };
    const newOwner = { daemon_id: "d_" + "22".repeat(10), pair_ref: "22".repeat(16) };
    expect(index.insert({ pair_loc: loc, ...oldOwner, exp: 2_000 })).toBe("ok");
    clock.now = 2_001;
    expect(index.insert({ pair_loc: loc, ...newOwner, exp: 3_000 })).toBe("ok");

    index.remove(loc, oldOwner);

    expect(index.lookup(loc)).toEqual({ pair_loc: loc, ...newOwner, exp: 3_000 });
  });

  test("concurrent opens never overlap external index writes", async () => {
    const { h, daemon } = await registeredRoom();
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const index: PairIndexClient = {
      lookup: async () => null,
      insert: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await firstGate;
        active--;
        return "ok";
      },
      remove: async () => {},
    };
    h.core.deps.index = index;

    const first = onMessage(h.core, daemon, pairOpen(h.core.daemonId, "11".repeat(16)));
    for (let i = 0; i < 20 && calls === 0; i++) await Promise.resolve();
    const second = onMessage(h.core, daemon, pairOpen(h.core.daemonId, "22".repeat(16)));
    await Promise.resolve();
    expect(maxActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
    expect(h.store.loadSlot()?.pair_ref).toBe("22".repeat(16));
  });

  test("failed refresh keeps the previous local deadline", async () => {
    const { h, daemon } = await registeredRoom();
    const pairRef = "33".repeat(16);
    await onMessage(h.core, daemon, pairOpen(h.core.daemonId, pairRef));
    const before = h.store.loadSlot()!;
    h.core.deps.index = {
      lookup: async () => null,
      insert: async () => "fail",
      remove: async () => {},
    };
    h.tick(1_000);

    await onMessage(h.core, daemon, pairOpen(h.core.daemonId, pairRef));

    expect(h.store.loadSlot()).toEqual(before);
    expect(lastJSON(daemon).body.code).toBe("index_unavailable");
    expect(lastJSON(daemon).body.pair_ref).toBe(pairRef);
  });

  test("disconnect during index insertion cannot leave an orphan slot", async () => {
    const { h, daemon } = await registeredRoom();
    const index = new IndexCore(new Map(), () => h.clock.t);
    let insertedLoc = "";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.core.deps.index = {
      lookup: async (loc) => index.lookup(loc),
      insert: async (row) => {
        await gate;
        insertedLoc = row.pair_loc;
        return index.insert(row);
      },
      remove: async (loc, owner) => index.remove(loc, owner),
    };

    const opening = onMessage(h.core, daemon, pairOpen(h.core.daemonId, "44".repeat(16)));
    await Promise.resolve();
    h.core.onClose(daemon);
    release();
    await opening;

    expect(h.store.loadSlot()).toBeNull();
    expect(insertedLoc).not.toBe("");
    expect(index.lookup(insertedLoc)).toBeNull();
  });

  test("a stale TTL alarm cannot erase a concurrently refreshed slot", async () => {
    const { h, daemon } = await registeredRoom();
    const pairRef = "55".repeat(16);
    await onMessage(h.core, daemon, pairOpen(h.core.daemonId, pairRef));
    h.tick(180_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.core.deps.index!;
    h.core.deps.index = {
      lookup: original.lookup.bind(original),
      insert: async (row) => {
        await gate;
        return original.insert(row);
      },
      remove: original.remove.bind(original),
    };

    const refresh = onMessage(h.core, daemon, pairOpen(h.core.daemonId, pairRef));
    await Promise.resolve();
    const alarm = h.core.alarm();
    release();
    await Promise.all([refresh, alarm]);

    expect(h.store.loadSlot()?.pair_ref).toBe(pairRef);
    expect(h.store.loadSlot()!.deadline).toBeGreaterThan(h.clock.t);
  });
});
