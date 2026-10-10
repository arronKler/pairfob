/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { CfStore } from "../../src/room/cf-store.ts";

it("avoids rewriting unchanged deadlines and reduces writes when refreshing an alarm", async () => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`writes-${crypto.randomUUID()}`));
  const result = await runInDurableObject(stub, async (_instance, ctx) => {
    new CfStore(ctx.storage).ensureSchema();
    let writes = 0;
    const store = new CfStore({ sql: {
      exec(query: string, ...binds: (string | number | null)[]) {
        const cursor = ctx.storage.sql.exec(query, ...binds);
        const rows = cursor.toArray();
        writes += cursor.rowsWritten;
        return { toArray: () => rows, rowsWritten: cursor.rowsWritten };
      },
    } } as unknown as DurableObjectStorage);
    store.upsertAlarm("pair_ttl", "pair", 100);
    writes = 0;
    store.upsertAlarm("pair_ttl", "pair", 100);
    const unchanged = writes;
    writes = 0;
    store.upsertAlarm("pair_ttl", "pair", 200);
    const refreshed = writes;
    writes = 0;
    const deleted = ctx.storage.sql.exec("DELETE FROM alarms WHERE kind = ? AND ref = ?", "pair_ttl", "pair");
    const inserted = ctx.storage.sql.exec("INSERT INTO alarms(at,kind,ref) VALUES(?,?,?)", 300, "pair_ttl", "pair");
    const legacy = deleted.rowsWritten + inserted.rowsWritten;
    const remaining = store.listAlarms();
    await ctx.storage.deleteAll();
    return { unchanged, refreshed, legacy, remaining };
  });
  expect(result).toMatchObject({ unchanged: 0, refreshed: 2, legacy: 4 });
  expect(result.remaining).toHaveLength(1);
  expect(result.remaining[0].at).toBe(300);
});

it("retains the original upsert behavior for legacy duplicate task references", async () => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`duplicates-${crypto.randomUUID()}`));
  const result = await runInDurableObject(stub, async (_instance, ctx) => {
    const store = new CfStore(ctx.storage);
    store.ensureSchema();
    ctx.storage.sql.exec("INSERT INTO alarms(at,kind,ref) VALUES(100,'pair_ttl','pair'),(200,'pair_ttl','pair'),(300,'hello_5s','other')");
    store.upsertAlarm("pair_ttl", "pair", 500);
    const remaining = store.listAlarms().map(({ at, kind, ref }) => ({ at, kind, ref }));
    await ctx.storage.deleteAll();
    return remaining;
  });
  expect(result).toHaveLength(2);
  expect(result).toContainEqual({ at: 500, kind: "pair_ttl", ref: "pair" });
  expect(result).toContainEqual({ at: 300, kind: "hello_5s", ref: "other" });
});
