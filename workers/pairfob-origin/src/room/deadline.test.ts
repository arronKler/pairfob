import { describe, expect, test } from "bun:test";
import { HELLO_GRACE_MS, RESUME_MS } from "../constants.ts";
import { routeHex, ZERO_ROUTE } from "../crypto.ts";
import { decode, Typ } from "../envelope.ts";
import { encodeJSON, encodeRaw } from "../frames.ts";
import { enrollDaemon, lastJSON, makeRoom } from "../testutil/make-room.ts";
import { onMessage } from "./ws.ts";

const ping = () => encodeRaw(Typ.PING, ZERO_ROUTE, new Uint8Array(8).fill(9));

async function resumeRoom() {
  const h = makeRoom();
  const daemon = await enrollDaemon(h);
  await onMessage(h.core, daemon.ws, encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
    v: 2, op: "RegisterDaemon", daemon_id: h.core.daemonId, reconnect_token: daemon.token,
  }));
  const accepted = h.accept("phone");
  if (!accepted.ok) throw new Error("phone upgrade failed");
  const phone = accepted.ws;
  await onMessage(h.core, phone, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
  await onMessage(h.core, phone, encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: h.core.daemonId }));
  return { h, phone, daemon: daemon.ws, route: lastJSON(phone).routeId };
}

describe("pending session deadline boundaries", () => {
  for (const offset of [-1, 0, 1]) {
    test(`ResumeHello alarm at deadline ${offset < 0 ? "-" : "+"} ${Math.abs(offset)} ms`, async () => {
      const { h, phone } = await resumeRoom();
      h.tick(RESUME_MS + offset);
      await h.core.alarm();
      if (offset < 0) {
        expect(phone.closed).toBe(false);
        expect(h.core.countKinds().resume).toBe(1);
        expect(h.store.listAlarms()).toHaveLength(1);
        expect(await h.store.getAlarm()).toBe(h.clock.t + 1);
        // The remaining alarm must close the same pending session exactly on time.
        h.tick(1);
        await h.core.alarm();
      }
      expect(phone.closed).toBe(true);
      expect(phone.closeReason).toBe("unpaired");
      expect(h.core.countKinds().resume).toBe(0);
      expect(h.store.listBinds()).toEqual([]);
      expect(h.store.listAlarms()).toEqual([]);
      expect(await h.store.getAlarm()).toBeNull();
    });

    test(`ResumeHello PING at deadline ${offset < 0 ? "-" : "+"} ${Math.abs(offset)} ms`, async () => {
      const { h, phone } = await resumeRoom();
      const stats = { ...h.store.stats };
      h.tick(RESUME_MS + offset);
      await onMessage(h.core, phone, ping());
      expect(phone.closed).toBe(offset >= 0);
      expect(decode(phone.sent.at(-1)!).typ).toBe(offset < 0 ? Typ.PONG : Typ.ERROR);
      expect(h.store.stats).toEqual(stats);
    });

    test(`Hello PING at deadline ${offset < 0 ? "-" : "+"} ${Math.abs(offset)} ms`, async () => {
      const h = makeRoom();
      const accepted = h.accept("phone");
      if (!accepted.ok) throw new Error("phone upgrade failed");
      await onMessage(h.core, accepted.ws, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
      const stats = { ...h.store.stats };
      h.tick(HELLO_GRACE_MS + offset);
      await onMessage(h.core, accepted.ws, ping());
      expect(accepted.ws.closed).toBe(offset >= 0);
      expect(decode(accepted.ws.sent.at(-1)!).typ).toBe(offset < 0 ? Typ.PONG : Typ.ERROR);
      expect(h.store.stats).toEqual(stats);
    });
  }

  test("an established session survives its former resume deadline and keeps storage-free PING", async () => {
    const { h, phone, daemon, route } = await resumeRoom();
    await onMessage(h.core, daemon, encodeJSON(Typ.SESSION_ESTABLISHED, route, { v: 2, route_id: routeHex(route) }));
    expect(h.core.att(phone)?.kind).toBe("established");
    for (const elapsed of [RESUME_MS, 1, 60_000]) {
      h.tick(elapsed);
      await h.core.alarm();
      const stats = { ...h.store.stats };
      await onMessage(h.core, phone, ping());
      expect(phone.closed).toBe(false);
      expect(decode(phone.sent.at(-1)!).typ).toBe(Typ.PONG);
      expect(h.store.stats).toEqual(stats);
    }
    expect(h.core.countKinds().est).toBe(1);
  });
});
