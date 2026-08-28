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

async function attachEstablished(h: ReturnType<typeof makeRoom>, daemon: FakeSocket): Promise<FakeSocket> {
  const p = h.accept("phone");
  await onMessage(h.core, p.ws!, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
  await onMessage(h.core, p.ws!, encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: h.core.daemonId }));
  const bound = lastJSON(p.ws!);
  await onMessage(h.core, daemon, encodeJSON(Typ.SESSION_ESTABLISHED, bound.routeId, { v: 2, route_id: routeHex(bound.routeId) }));
  return p.ws!;
}

describe("bind teardown", () => {
  test("phone close unpins the daemon", async () => {
    const h = makeRoom();
    const daemon = await openDaemon(h);
    const phone = await attachEstablished(h, daemon);
    expect(h.core.countKinds().est).toBe(1);
    phone.close();
    h.core.onClose(phone);
    expect(lastJSON(daemon).body.code).toBe("unpaired");
    expect(h.core.countKinds().est).toBe(0);
  });

  test("daemon unpaired ERROR closes the phone bind", async () => {
    const h = makeRoom();
    const daemon = await openDaemon(h);
    const phone = await attachEstablished(h, daemon);
    const rid = lastJSON(phone).routeId;
    await onMessage(
      h.core,
      daemon,
      encodeJSON(Typ.ERROR, rid, { v: 2, code: "unpaired", route_id: routeHex(rid), message: "aead failed" }),
    );
    expect(lastJSON(phone).body.code).toBe("unpaired");
    expect(phone.closed).toBe(true);
    expect(h.core.countKinds().est).toBe(0);
    expect(h.core.findByRoute(routeHex(rid))).toBeNull();
    expect(lastJSON(daemon).typ).not.toBe(Typ.ERROR);
  });
});
