import { describe, expect, test } from "bun:test";
import { ZERO_ROUTE, routeHex } from "../crypto.ts";
import { sha256Hex } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON } from "../frames.ts";
import { lastJSON, makeRoom } from "../testutil/make-room.ts";
import { onMessage } from "./ws.ts";
import type { FakeSocket } from "./fake-socket.ts";

async function openDaemon(h: ReturnType<typeof makeRoom>): Promise<FakeSocket> {
  const token = "rt_" + "22".repeat(16);
  h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "22".repeat(8) });
  const d = h.accept("daemon");
  await onMessage(
    h.core,
    d.ws!,
    encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: h.core.daemonId,
      reconnect_token: token,
    }),
  );
  return d.ws!;
}

async function attachSession(h: ReturnType<typeof makeRoom>): Promise<FakeSocket> {
  const p = h.accept("phone");
  await onMessage(h.core, p.ws!, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
  await onMessage(
    h.core,
    p.ws!,
    encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: h.core.daemonId }),
  );
  return p.ws!;
}

describe("session caps", () => {
  test("11th Established is too_many_devices", async () => {
    const h = makeRoom();
    const daemon = await openDaemon(h);
    for (let i = 0; i < 10; i++) {
      const phone = await attachSession(h);
      const bound = lastJSON(phone);
      expect(bound.typ).toBe(Typ.SESSION_BOUND);
      const rid = bound.routeId;
      await onMessage(
        h.core,
        daemon,
        encodeJSON(Typ.SESSION_ESTABLISHED, rid, { v: 2, route_id: routeHex(rid) }),
      );
    }
    expect(h.core.countKinds().est).toBe(10);
    const p11 = await attachSession(h);
    const bound11 = lastJSON(p11);
    await onMessage(
      h.core,
      daemon,
      encodeJSON(Typ.SESSION_ESTABLISHED, bound11.routeId, { v: 2, route_id: routeHex(bound11.routeId) }),
    );
    const err = lastJSON(p11);
    expect(err.typ).toBe(Typ.ERROR);
    expect(err.body.code).toBe("too_many_devices");
    expect(h.core.countKinds().est).toBe(10);
  });

  test("3rd ResumeHello kicks LRU", async () => {
    const h = makeRoom();
    await openDaemon(h);
    const a = await attachSession(h);
    h.tick(5);
    const b = await attachSession(h);
    h.tick(5);
    const c = await attachSession(h);
    const kicked = lastJSON(a);
    expect(kicked.typ).toBe(Typ.ERROR);
    expect(kicked.body.code).toBe("kicked");
    expect(a.closed).toBe(true);
    expect(h.core.countKinds().resume).toBe(2);
    expect(b.closed).toBe(false);
    expect(c.closed).toBe(false);
  });
});
