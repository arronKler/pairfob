/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { CfStore } from "../../src/room/cf-store.ts";
import { RoomCore } from "../../src/room/core.ts";
import { ROOM_DDL } from "../../src/room/schema.ts";

it.each(["refresh", "rowid_reuse"])("keeps a refreshed TTL during a pairing lock wait (%s)", async (mode) => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`refresh-${crypto.randomUUID()}`));
  const result = await runInDurableObject(stub, async (_instance, ctx) => {
    const now = Date.now();
    const store = new CfStore(ctx.storage);
    const core = new RoomCore({ store, now: () => now, daemonId: "test",
      randomBytes: (n) => new Uint8Array(n), sockets: () => [] });
    store.putSlot({ pair_ref: "pair", pair_loc: "loc", deadline: now - 1 });
    store.upsertAlarm("pair_ttl", "pair", now - 1);
    const originalId = store.listAlarms()[0].id;
    let unlock!: () => void;
    const held = core.withPairingLock(() => new Promise<void>((resolve) => { unlock = resolve; }));
    await Promise.resolve();
    const harvesting = core.alarm();
    const future = now + 3_600_000;
    store.putSlot({ pair_ref: "pair", pair_loc: "loc", deadline: future });
    if (mode === "rowid_reuse") {
      // Exercise the historical DELETE/INSERT race even when upsert updates in place.
      ctx.storage.sql.exec("DELETE FROM alarms WHERE kind = 'pair_ttl' AND ref = 'pair'");
      ctx.storage.sql.exec("INSERT INTO alarms(at,kind,ref) VALUES(?,'pair_ttl','pair')", future);
    } else store.upsertAlarm("pair_ttl", "pair", future);
    const refreshedId = store.listAlarms()[0].id;
    unlock();
    await held;
    await harvesting;
    const state = { originalId, refreshedId, future, slot: store.loadSlot(),
      rows: store.listAlarms(), alarm: await ctx.storage.getAlarm() };
    await ctx.storage.deleteAll();
    return state;
  });
  expect(result.refreshedId).toBe(result.originalId);
  expect(result.slot?.deadline).toBe(result.future);
  expect(result.rows).toEqual([{ id: result.refreshedId, at: result.future, kind: "pair_ttl", ref: "pair" }]);
  expect(result.alarm).toBe(result.future);
});

it("indexes bound scans and drains a legacy alarm backlog without losing future work", async () => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`backlog-${crypto.randomUUID()}`));
  const result = await runInDurableObject(stub, async (_instance, ctx) => {
    // Model an existing database before the new indexes are installed.
    for (const ddl of ROOM_DDL) if (!ddl.startsWith("CREATE INDEX")) ctx.storage.sql.exec(ddl);
    ctx.storage.sql.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<14500)
      INSERT INTO alarms(at,kind,ref) SELECT x,'hello_5s',CAST(x AS TEXT) FROM n`);
    const before = ctx.storage.sql.exec("SELECT MIN(at) AS m FROM alarms");
    before.toArray();
    const store = new CfStore(ctx.storage);
    store.ensureSchema();
    const after = ctx.storage.sql.exec("SELECT MIN(at) AS m FROM alarms");
    after.toArray();
    const future = Date.now() + 60_000;
    store.upsertAlarm("hello_5s", "future", future);
    let removed = 0, maxBatch = 0;
    while (true) {
      const rows = store.dueAlarms(Date.now());
      if (!rows.length) break;
      maxBatch = Math.max(maxBatch, rows.length);
      removed += rows.length;
      store.deleteAlarmRows(rows);
    }
    const remaining = store.listAlarms();
    const scans = { before: before.rowsRead, after: after.rowsRead };
    await ctx.storage.deleteAll();
    return { scans, removed, maxBatch, remaining: remaining.map(({ ref, at }) => ({ ref, at })), future };
  });
  expect(result.scans.before).toBeGreaterThanOrEqual(14500);
  expect(result.scans.after).toBeLessThanOrEqual(2);
  expect(result.removed).toBe(14500);
  expect(result.maxBatch).toBe(128);
  expect(result.remaining).toEqual([{ ref: "future", at: result.future }]);
});

it("the actual alarm handler retains a wakeup until all due batches have drained", async () => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`chain-${crypto.randomUUID()}`));
  const future = await runInDurableObject(stub, async (_instance, ctx) => {
    const store = new CfStore(ctx.storage);
    store.ensureSchema();
    ctx.storage.sql.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300)
      INSERT INTO alarms(at,kind,ref) SELECT x,'hello_5s',CAST(x AS TEXT) FROM n`);
    const future = Date.now() + 3_600_000;
    store.upsertAlarm("hello_5s", "future", future);
    await ctx.storage.setAlarm(Date.now() + 20);
    return future;
  });
  await expect.poll(() => runInDurableObject(stub, async (_instance, ctx) => ({
      remaining: ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM alarms").one().n,
      alarm: await ctx.storage.getAlarm(),
    })), { interval: 20, timeout: 5000 }).toEqual({ remaining: 1, alarm: future });
  await runInDurableObject(stub, async (_instance, ctx) => { await ctx.storage.deleteAll(); });
});
