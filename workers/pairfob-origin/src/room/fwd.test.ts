import { describe, expect, test } from "bun:test";
import { routeHex, sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { decode, HEADER_SIZE, Typ } from "../envelope.ts";
import { encodeJSON, encodeRaw } from "../frames.ts";
import { lastJSON, makeRoom, PAIR_REF } from "../testutil/make-room.ts";
import type { FakeSocket } from "./fake-socket.ts";
import { onMessage } from "./ws.ts";

async function registeredRoom(): Promise<{
  room: ReturnType<typeof makeRoom>;
  daemon: FakeSocket;
}> {
  const room = makeRoom();
  const token = "rt_" + "42".repeat(16);
  room.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "42".repeat(8) });
  const daemon = room.accept("daemon");
  if (!daemon.ok) throw new Error("daemon upgrade failed");
  await onMessage(
    room.core,
    daemon.ws,
    encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: room.core.daemonId,
      reconnect_token: token,
    }),
  );
  return { room, daemon: daemon.ws };
}

async function establishedRoom(): Promise<{
  room: ReturnType<typeof makeRoom>;
  daemon: FakeSocket;
  phone: FakeSocket;
  routeId: Uint8Array;
}> {
  const { room, daemon } = await registeredRoom();

  const phone = room.accept("phone");
  if (!phone.ok) throw new Error("phone upgrade failed");
  await onMessage(room.core, phone.ws, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
  await onMessage(
    room.core,
    phone.ws,
    encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: room.core.daemonId }),
  );
  const routeId = lastJSON(phone.ws).routeId;
  await onMessage(
    room.core,
    daemon,
    encodeJSON(Typ.SESSION_ESTABLISHED, routeId, { v: 2, route_id: routeHex(routeId) }),
  );
  return { room, daemon, phone: phone.ws, routeId };
}

describe("opaque FWD hot path", () => {
  test("client stamps its bound route and forwards the original wire buffer", async () => {
    const { room, daemon, phone, routeId } = await establishedRoom();
    const payload = Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff);
    const wire = encodeRaw(Typ.FWD, ZERO_ROUTE, payload);
    const originalPayload = wire.slice(HEADER_SIZE);
    const sqlBefore = room.store.stats.sql;
    daemon.lastSentInput = null;
    phone.attachmentReads = 0;
    const bytesBefore = room.core.fwdBytes;

    const handled = onMessage(room.core, phone, wire);

    expect(handled).toBeUndefined();
    expect(daemon.lastSentInput).toBe(wire);
    expect(phone.attachmentReads).toBe(1);
    expect(decode(wire).routeId).toEqual(routeId);
    expect(wire.subarray(HEADER_SIZE)).toEqual(originalPayload);
    expect(room.core.fwdBytes - bytesBefore).toBe(payload.length);
    expect(room.store.stats.sql).toBe(sqlBefore);
  });

  test("daemon finds the bound client without rebuilding and forwards the original wire buffer", async () => {
    const { room, daemon, phone, routeId } = await establishedRoom();
    const wire = encodeRaw(Typ.FWD, routeId, new Uint8Array(4096).fill(0x5a));
    const sqlBefore = room.store.stats.sql;
    phone.lastSentInput = null;
    phone.attachmentReads = 0;
    daemon.attachmentReads = 0;
    const bytesBefore = room.core.fwdBytes;

    const handled = onMessage(room.core, daemon, wire);

    expect(handled).toBeUndefined();
    expect(phone.lastSentInput).toBe(wire);
    expect(phone.attachmentReads).toBe(0);
    expect(daemon.attachmentReads).toBe(1);
    expect(room.core.fwdBytes - bytesBefore).toBe(4096);
    expect(room.store.stats.sql).toBe(sqlBefore);
  });

  test("malformed FWD is rejected before forwarding or accounting bytes", async () => {
    const { room, daemon, phone } = await establishedRoom();
    const wire = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array([1, 2, 3]));
    wire[3] = 1;
    daemon.lastSentInput = null;
    const bytesBefore = room.core.fwdBytes;

    onMessage(room.core, phone, wire);

    expect(daemon.lastSentInput).toBeNull();
    expect(room.core.fwdBytes).toBe(bytesBefore);
    expect(phone.closed).toBe(true);
    expect(lastJSON(phone).body).toMatchObject({ code: "bad_frame", message: "invalid envelope" });
  });

  test("FWD fast path preserves first-frame role checks", () => {
    const room = makeRoom();
    const phone = room.accept("phone");
    const daemon = room.accept("daemon");
    if (!phone.ok || !daemon.ok) throw new Error("upgrade failed");
    const wire = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array([1]));

    onMessage(room.core, phone.ws, wire.slice());
    onMessage(room.core, daemon.ws, wire.slice());

    expect(lastJSON(phone.ws).body).toMatchObject({ code: "unbound", message: "HELLO_CLIENT must be the first frame" });
    expect(lastJSON(daemon.ws).body).toMatchObject({ code: "unbound", message: "HELLO_DAEMON must be the first frame" });
    expect(phone.ws.closed).toBe(true);
    expect(daemon.ws.closed).toBe(true);
  });

  test("route index rebuilds from hibernation attachments", async () => {
    const { room, daemon, phone, routeId } = await establishedRoom();
    room.core.rebuildMaps();
    const wire = encodeRaw(Typ.FWD, routeId, new Uint8Array([7, 8, 9]));
    phone.lastSentInput = null;

    await onMessage(room.core, daemon, wire);

    expect(phone.lastSentInput).toBe(wire);
  });

  test("closed binds leave no stale hot-path route", async () => {
    const { room, phone, routeId } = await establishedRoom();
    const hex = routeHex(routeId);

    room.core.closeBind(phone, "kicked", "test close", false);

    expect(room.core.findByRoute(hex)).toBeNull();
  });

  test("pairing progress remains durable before its original wire buffer is forwarded", async () => {
    const { room, daemon } = await registeredRoom();
    await onMessage(
      room.core,
      daemon,
      encodeJSON(Typ.PAIR_OPEN, ZERO_ROUTE, {
        v: 2,
        op: "CreatePairing",
        daemon_id: room.core.daemonId,
        pair_ref: PAIR_REF,
        ttl_s: 180,
      }),
    );
    const phone = room.accept("phone");
    if (!phone.ok) throw new Error("phone upgrade failed");
    await onMessage(room.core, phone.ws, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
    await onMessage(room.core, phone.ws, encodeJSON(Typ.PAIR_ATTACH, ZERO_ROUTE, { v: 2, pair_ref: PAIR_REF }));
    const routeId = lastJSON(phone.ws).routeId;
    const wire = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array([1, 2, 3]));
    daemon.lastSentInput = null;

    const handled = onMessage(room.core, phone.ws, wire);
    expect(handled).toBeInstanceOf(Promise);
    await handled;

    expect(daemon.lastSentInput).toBe(wire);
    expect(decode(wire).routeId).toEqual(routeId);
    expect(room.store.listAlarms().some((alarm) => alarm.kind === "pair_confirm_30s")).toBe(true);
  });
});
