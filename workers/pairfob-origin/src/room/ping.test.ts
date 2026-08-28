import { describe, expect, test } from "bun:test";
import { Typ } from "../envelope.ts";
import { encodeRaw } from "../frames.ts";
import { ZERO_ROUTE } from "../crypto.ts";
import { onMessage } from "./ws.ts";
import { makeRoom } from "../testutil/make-room.ts";

describe("PING storage", () => {
  test("PING/PONG does not touch SQL or platform alarms", async () => {
    const h = makeRoom();
    const acc = h.accept("phone");
    expect(acc.ok).toBe(true);
    const sql0 = h.store.stats.sql;
    const get0 = h.store.stats.getAlarm;
    const set0 = h.store.stats.setAlarm;
    const del0 = h.store.stats.deleteAlarm;
    await onMessage(h.core, acc.ws!, encodeRaw(Typ.PING, ZERO_ROUTE, new Uint8Array(8).fill(9)));
    expect(h.store.stats.sql).toBe(sql0);
    expect(h.store.stats.getAlarm).toBe(get0);
    expect(h.store.stats.setAlarm).toBe(set0);
    expect(h.store.stats.deleteAlarm).toBe(del0);
    expect(acc.ws!.sent.length).toBe(1);
    const pong = acc.ws!.sent[0];
    expect(pong[1]).toBe(Typ.PONG);
  });
});
